/**
 * Offline regression for two interpretation-packet changes:
 *
 * 1. Classify context is deduplicated and bounded to a sentence window around each
 *    introducing span, while offsets still index the original passage text.
 * 2. The model adapter asks for public `reasoning: 'low'` only when the installed
 *    catalog reports that level as supported, and never changes the caller's
 *    `maxOutputTokens` (the reservation/ledger ceiling) or settles usage itself.
 *
 * Run: ./node_modules/.bin/tsx test/pi-model-context.test.ts   (exit 1 on failure)
 */
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { OUTPUT_TOKENS, classifyContext, classifySpanContext } from '../src/engine.js';
import { makeModelHost } from '../src/pi-model.js';
import type { Concept, Passage } from '../src/types.js';

const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`ok   ${label}`);
  else { failures.push(label); console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- classify packet

const TEXT = 'Aaa bbb. Ccc ddd. Eee fff.';
const passage: Passage = {
  id: 'p1', snapshotId: 's1', start: 0, end: TEXT.length, text: TEXT, duplicateGroup: 'p1',
};
const passages = new Map<string, Passage>([[passage.id, passage]]);
const span = (start: number, end: number, passageId = 'p1') => ({ passageId, start, end });
const concept = (id: string, introducing: Concept['introducing']): Concept => ({
  id, branchId: 'b1', term: 'ddd', score: 0.9, anchorRelevance: 0.8, introducing,
});

// 'ddd' occupies [13,16); its sentence is 'Ccc ddd.' at [9,17).
const middle = classifySpanContext(TEXT, { start: 13, end: 16 });
check('bounded context exists for a valid span', middle !== undefined);
check('excerpt text is exactly the passage slice it reports',
  !!middle && TEXT.slice(middle.excerpt.start, middle.excerpt.end) === middle.excerpt.text,
  JSON.stringify(middle?.excerpt));
check('span offsets stay passage-relative and select the original term',
  TEXT.slice(middle!.start, middle!.end) === 'ddd', JSON.stringify(middle));
check('window expands to the enclosing sentence', middle!.excerpt.text === 'Ccc ddd.', JSON.stringify(middle!.excerpt));
check('window is not the whole passage', middle!.excerpt.text !== TEXT);
check('window retains neighbouring sentence context', middle!.excerpt.start > 0 && middle!.excerpt.end < TEXT.length);

// Bounded expansion: long sentences cannot grow the window past the context budget.
const LONG = Array.from({ length: 6 }, (_, i) => `${'word '.repeat(100)}marker${i} ${'tail '.repeat(100)}.`).join(' ');
const markerAt = LONG.indexOf('marker2');
const longWindow = classifySpanContext(LONG, { start: markerAt, end: markerAt + 'marker2'.length })!;
check('long-sentence window is bounded to the context budget',
  longWindow.excerpt.text.length <= 'marker2'.length + 2 * 480, `len=${longWindow.excerpt.text.length}`);
check('long-sentence window still contains the complete span',
  longWindow.excerpt.text.includes('marker2') && longWindow.excerpt.start <= markerAt &&
  longWindow.excerpt.end >= markerAt + 'marker2'.length);

// A span at the passage edges must not fall outside the text.
check('edges clamp inside the passage',
  classifySpanContext(TEXT, { start: 0, end: 3 })!.excerpt.start === 0 &&
  classifySpanContext(TEXT, { start: TEXT.length - 3, end: TEXT.length })!.excerpt.end === TEXT.length);
check('invalid bounds contribute no context',
  classifySpanContext(TEXT, { start: 5, end: 5 }) === undefined &&
  classifySpanContext(TEXT, { start: -1, end: 3 }) === undefined &&
  classifySpanContext(TEXT, { start: 20, end: TEXT.length + 1 }) === undefined &&
  classifySpanContext(TEXT, { start: 1.5, end: 3 }) === undefined);

// Deduplication across concepts and within one concept.
const shared = classifyContext([concept('c1', [span(13, 16)]), concept('c2', [span(13, 16)])], passages);
check('identical spans on two concepts share one evidence entry', shared.evidence.length === 1,
  `evidence=${shared.evidence.length}`);
check('both concepts reference the shared window', shared.concepts.every(c => c.introducing.length === 1) &&
  shared.concepts[0]!.introducing[0]!.start === 13 && shared.concepts[1]!.introducing[0]!.start === 13);
check('evidence references resolve to the supplied window text',
  shared.evidence[0]!.passageId === 'p1' && TEXT.slice(shared.evidence[0]!.start, shared.evidence[0]!.end) === 'ddd');

const covered = classifyContext([concept('c1', [span(13, 16)]), concept('c2', [span(9, 12)])], passages);
check('a span inside an existing window reuses it instead of repeating text', covered.evidence.length === 1,
  `evidence=${covered.evidence.length}`);
check('the reused reference keeps its own truthful offsets', covered.concepts[1]!.introducing[0]!.start === 9);

const distinct = classifyContext([concept('c1', [span(13, 16), span(18, 21)])], passages);
check('distinct windows on one passage are both supplied', distinct.evidence.length === 2,
  `evidence=${distinct.evidence.length}`);

const repeated = classifyContext([concept('c1', [span(13, 16), span(13, 16)])], passages);
check('an identical span repeated inside one concept is deduplicated',
  repeated.concepts[0]!.introducing.length === 1 && repeated.evidence.length === 1);

const capped = classifyContext([concept('c1', [span(0, 3), span(4, 7), span(9, 12), span(13, 16)])], passages);
check('a concept keeps at most three introducing spans', capped.concepts[0]!.introducing.length === 3,
  `refs=${capped.concepts[0]!.introducing.length}`);

const missing = classifyContext([concept('c1', [span(13, 16, 'absent')])], passages);
check('unknown passages contribute no evidence and no reference',
  missing.evidence.length === 0 && missing.concepts[0]!.introducing.length === 0);

// ---------------------------------------------------------------- adapter options

const usage: Usage = {
  input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const message = (): AssistantMessage => ({
  role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }], api: 'openai-responses',
  provider: 'openai', model: 'fake-context-model', usage, stopReason: 'stop', timestamp: Date.now(),
});

interface Observed { options?: Record<string, unknown>; model?: unknown }
function fakeCtx(model: Record<string, unknown>): { ctx: ExtensionToolContext; seen: Observed[] } {
  const seen: Observed[] = [];
  const ctx = {
    model,
    sessionManager: { getSessionId: () => 'session-context' },
    modelRegistry: {
      streamSimple: (observedModel: unknown, _context: unknown, options?: Record<string, unknown>) => {
        seen.push({ options, model: observedModel });
        return { result: async () => message() };
      },
    },
  } as unknown as ExtensionToolContext;
  return { ctx, seen };
}

const call = async (model: Record<string, unknown>, maxOutputTokens: number) => {
  const { ctx, seen } = fakeCtx(model);
  await makeModelHost(ctx, () => {}).complete('assess', { question: 'q' }, {
    signal: new AbortController().signal, maxOutputTokens,
  });
  if (seen.length !== 1) throw new Error(`expected one provider call, saw ${seen.length}`);
  return seen[0]!.options!;
};

const capable = await call({ provider: 'openai', id: 'm', api: 'openai-responses', reasoning: true }, OUTPUT_TOKENS.assess);
check('reasoning-capable model receives public reasoning low', capable.reasoning === 'low', String(capable.reasoning));
check('caller maxOutputTokens is forwarded unchanged with reasoning enabled', capable.maxTokens === 8000,
  String(capable.maxTokens));
check('sessionId still carried with reasoning', capable.sessionId === 'session-context');

const plain = await call({ provider: 'openai', id: 'm', api: 'openai-responses', reasoning: false }, 2500);
check('non-reasoning model receives no reasoning option', !('reasoning' in plain), JSON.stringify(plain));
check('non-reasoning call keeps the caller cap', plain.maxTokens === 2500, String(plain.maxTokens));

const unsupported = await call({
  provider: 'openai', id: 'm', api: 'openai-responses', reasoning: true, thinkingLevelMap: { low: null },
}, 5000);
check('a model that reports low as unsupported receives no reasoning option', !('reasoning' in unsupported),
  JSON.stringify(unsupported));

const mapped = await call({
  provider: 'openai', id: 'm', api: 'openai-responses', reasoning: true, thinkingLevelMap: { low: 'reasoning_effort_low' },
}, 5000);
check('a mapped-but-supported low level is still requested', mapped.reasoning === 'low');

check('reserved output ceilings: assess 8000, classify 2500, report 12000, plan 3000',
  OUTPUT_TOKENS.assess === 8000 && OUTPUT_TOKENS.classify === 2500 && OUTPUT_TOKENS.report === 12000 &&
  OUTPUT_TOKENS.plan === 3000, JSON.stringify(OUTPUT_TOKENS));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
