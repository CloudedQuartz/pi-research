/**
 * Offline regression for the live native root: the provider answered
 * HTTP 400 MissingSessionID because makeModelHost's streamSimple call omitted the
 * request session identifier. The pinned public API carries it as
 * SimpleStreamOptions.sessionId, sourced from ctx.sessionManager.getSessionId().
 * This fake provider rejects a request with no sessionId and accepts only the
 * option, so it also guards against passing a provider-specific header instead.
 *
 * Run: ./node_modules/.bin/tsx test/pi-model-session.test.ts   (exit 1 on failure)
 */
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { makeModelHost } from '../src/pi-model.js';

const SESSION_ID = 'session-abc-123';
const failures: string[] = [];
const check = (label: string, condition: boolean): void => {
  if (condition) console.log(`ok   ${label}`);
  else { failures.push(label); console.log(`FAIL ${label}`); }
};

const usage: Usage = {
  input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = (text: string, stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'openai-responses', provider: 'openai',
  model: 'fake-session-model', usage, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
});

let calls = 0;
let observedSessionId: string | undefined;
let observedHeaders: unknown;
const ctx = {
  model: { provider: 'openai', id: 'fake-session-model', api: 'openai-responses' },
  sessionManager: { getSessionId: () => SESSION_ID },
  modelRegistry: {
    streamSimple: (_model: unknown, _context: unknown, options?: { sessionId?: string; headers?: unknown }) => {
      calls++;
      observedSessionId = options?.sessionId;
      observedHeaders = options?.headers;
      const result = typeof options?.sessionId === 'string' && options.sessionId.length > 0
        ? message('{"ok":true}', 'stop')
        : message('', 'error', 'HTTP 400: MissingSessionID');
      return { result: async () => result };
    },
  },
} as unknown as ExtensionToolContext;

const host = makeModelHost(ctx, () => {});
let accepted = false;
let failure = '';
try {
  const response = await host.complete('plan', { question: 'q' }, {
    signal: new AbortController().signal, maxOutputTokens: 512,
  });
  accepted = (response.value as { ok?: boolean }).ok === true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
check('provider accepts the request (no MissingSessionID)', accepted);
check('streamSimple received options.sessionId from ctx.sessionManager.getSessionId()', observedSessionId === SESSION_ID);
check('no provider-specific session header was used', observedHeaders === undefined);
check('exactly one provider call (no retries)', calls === 1);

if (!accepted) console.error(`\nmodel call failed: ${failure}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
