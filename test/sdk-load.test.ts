/**
 * Offline host-load regression for the real Pi 1.0.4 SDK path: jiti extension discovery,
 * ExtensionRunner, SessionManager.inMemory and a throwing-stub ModelRegistry against the
 * real src/extension.ts. Asserts the registered host surface (6 tools, 8 commands, all six
 * current lifecycle hooks) and that empty-branch restore plus before-event invalidation do
 * no model or fetch work. Model availability is intentionally untested: a throwing
 * ModelRegistry proves zero model touches. No AuthStorage, no pi CLI, no network.
 *
 * Run: ./node_modules/.bin/tsx test/sdk-load.test.ts   (exit 1 on any failed check)
 */
process.env.PI_OFFLINE = '1';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../src/extension.ts', import.meta.url));
const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'pi-sdk-load-'));
const cwd = join(tempRoot, 'cwd');
const agentDir = join(tempRoot, 'agent');
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const failures: string[] = [];
const check = (label: string, condition: boolean): void => {
  if (condition) console.log(`ok   ${label}`);
  else { failures.push(label); console.log(`FAIL ${label}`); }
};
const nativeFetch = globalThis.fetch;
const calls = { fetch: 0, model: 0, ui: 0 };
globalThis.fetch = (): ReturnType<typeof fetch> => {
  calls.fetch++;
  throw new Error('Network calls are forbidden in the offline SDK regression');
};

try {
  const { discoverAndLoadExtensions, ExtensionRunner, SessionManager } = await import('@earendil-works/pi-coding-agent');
  // The fourth loader argument is the optional event bus, never AuthStorage; temp cwd and
  // agentDir keep project/global extension discovery away from the repository and home.
  const { extensions, errors, runtime } = await discoverAndLoadExtensions([EXT], cwd, agentDir, undefined);
  check('discoverAndLoadExtensions reports no errors', errors.length === 0);
  check('exactly one extension loads via jiti', extensions.length === 1);
  const manifestLoad = await discoverAndLoadExtensions([PACKAGE], cwd, agentDir, undefined);
  check('package manifest loads both extensions without errors', manifestLoad.errors.length === 0 && manifestLoad.extensions.length === 2);
  const commandNames = manifestLoad.extensions.flatMap(extension => [...extension.commands.keys()]);
  const toolNames = manifestLoad.extensions.flatMap(extension => [...extension.tools.keys()]);
  check('no command or tool name is registered twice across the package',
    new Set(commandNames).size === commandNames.length && new Set(toolNames).size === toolNames.length);
  check('/research is the one-command workflow; the IR engine starts with /research-engine',
    commandNames.includes('research') && commandNames.includes('research-finish') && commandNames.includes('research-engine') && toolNames.includes('research_round'));
  const ext = extensions[0]!;
  const defs = [...ext.tools.values()].map(registered => registered.definition);
  check('exactly 6 registered tools', defs.length === 6);
  check('exactly 8 registered commands', ext.commands.size === 8);
  const hooks = ['session_start', 'session_tree', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_shutdown'];
  check('all six current lifecycle hooks have handlers', hooks.every(hook => (ext.handlers.get(hook)?.length ?? 0) > 0));
  const run = defs.find(definition => definition.name === 'research_run');
  check('research_run is model-only and sequential', run?.exposure === 'model-only' && run.executionMode === 'sequential');
  const retrieve = defs.find(definition => definition.name === 'research_retrieve');
  check('research_retrieve is read-only and closed-world', retrieve?.annotations?.readOnlyHint === true && retrieve.annotations.openWorldHint === false);

  const throwingRegistry = new Proxy({}, { get: (_target, key) => () => { calls.model++; throw new Error(`ModelRegistry.${String(key)} must not be called`); } });
  const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), throwingRegistry as any);
  const actions = new Proxy({}, { get: (_target, key) => () => { if (key === 'getAllTools' || key === 'getActiveTools' || key === 'getCommands') return []; if (key === 'getSettings') return {}; return undefined; } });
  const contextActions = new Proxy({}, { get: (_target, key) => () => key === 'getSystemPromptOptions' ? { cwd } : undefined });
  runner.bindCore(actions as any, contextActions as any);
  const uiTarget = { select: 0, confirm: 0, input: 0, notify: 0, setStatus: 0, setWidget: 0, custom: 0, editor: 0, theme: {} };
  const ui = new Proxy(uiTarget, { get: (target, key) => key === 'theme' ? target.theme : () => { calls.ui++; return undefined; } });
  runner.setUIContext(ui as any, 'tui');

  const handlerErrors: string[] = [];
  runner.onError(error => handlerErrors.push(`${error.event}: ${error.error}`));
  // Empty in-memory branch: restore finds no investigation and before-events invalidate with no active run.
  await runner.emit({ type: 'session_start', reason: 'startup' });
  await runner.emit({ type: 'session_tree', newLeafId: null, oldLeafId: null });
  const workBeforeInvalidation = calls.ui;
  await runner.emit({ type: 'session_before_switch', reason: 'new' });
  await runner.emit({ type: 'session_before_fork', entryId: 'none', position: 'before' });
  await runner.emit({ type: 'session_before_tree', preparation: { targetId: 'none', oldLeafId: null, commonAncestorId: null, entriesToSummarize: [], userWantsSummary: false }, signal: new AbortController().signal });
  check('before-event invalidation with no active run does no work', calls.ui === workBeforeInvalidation && calls.model === 0 && calls.fetch === 0);
  await runner.emit({ type: 'session_shutdown', reason: 'quit' });
  check('lifecycle emission reports no handler errors', handlerErrors.length === 0);
  check('runner dispatched lifecycle events (UI calls observed)', calls.ui > 0);
  check('0 ModelRegistry method touches (throwing registry untouched)', calls.model === 0);
  check('0 globalThis.fetch calls', calls.fetch === 0);
} finally {
  globalThis.fetch = nativeFetch;
  rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
