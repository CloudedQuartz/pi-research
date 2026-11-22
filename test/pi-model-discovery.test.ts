/**
 * Offline regression for provider-free `/research` authorization and configured-default
 * discovery normalization.
 *
 * A new investigation no longer prompts for a provider or tool name: it persists the
 * `configured-default` marker in the existing provider field, selects the registered
 * `web_search` tool, and its consent names the fan-out and one-invocation accounting.
 * Replies from a call that named no provider are normalized truthfully: a single
 * reported provider keeps its own ranking semantics, while aggregated, ambiguous or
 * unlabeled replies carry no rank. Explicit provider bindings stay strictly checked.
 * No network, model or host calls are made.
 *
 * Run: npx tsx test/pi-model-discovery.test.ts   (exit 1 on any failed check)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Ledger } from '../src/allowance.js';
import researchExtension from '../src/extension.js';
import { CONFIGURED_DEFAULT_PROVIDER, normalizeConfiguredDiscovery, normalizeDiscovery } from '../src/pi-model.js';

const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`ok   ${label}`);
  else { failures.push(label); console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const threw = (work: () => unknown): string => {
  try { work(); return ''; } catch (error) { return error instanceof Error ? error.message : String(error); }
};
const query = 'What limits BM25 ranking?';

// ------------------------------------------------- authorization without provider input

const dir = mkdtempSync(join(tmpdir(), 'pi-model-discovery-'));
const entries: { customType: string; data: unknown }[] = [];
const sent: string[] = [];
const notifications: string[] = [];
const inputs: string[] = [];
let confirmText = '';
const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
const pi = {
  on() {}, registerTool() {},
  registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) { commands.set(name, definition); },
  getAllTools: () => [{ name: 'web_search', label: 'Web search', exposure: 'public' }],
  getActiveTools: () => [], setActiveTools() {},
  appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
  sendUserMessage(text: string) { sent.push(text); },
  sendMessage() {},
} as unknown as ExtensionAPI;
researchExtension(pi);
const ctx = {
  hasUI: true,
  waitForIdle: async () => {},
  sessionManager: {
    getSessionId: () => 'session-fixture',
    getSessionDir: () => dir,
    getBranch: () => entries.map(entry => ({ type: 'custom', customType: entry.customType, data: entry.data })),
  },
  ui: {
    input: async () => { inputs.push('asked'); return 'brave'; },
    confirm: async (_title: string, body: string) => { confirmText = body; return true; },
    notify(message: string) { notifications.push(message); },
    setStatus() {}, setWidget() {},
  },
  mode: 'rpc',
} as unknown as ExtensionCommandContext;

await commands.get('research')!.handler(query, ctx);
check('start authorization succeeds', confirmText !== '' && notifications.length === 0,
  notifications.join(' | '));
check('no provider or tool prompt is shown', inputs.length === 0, JSON.stringify(inputs));
check('consent names the configured default and the selected tool',
  confirmText.includes('configured default') && confirmText.includes('web_search'), confirmText);
check('consent discloses configured-provider fan-out and one-invocation accounting',
  confirmText.includes('may fan out') && confirmText.includes('one search invocation is counted'), confirmText);

const config = entries.find(entry => entry.customType === 'pi-research/config')?.data as
  { provider?: unknown; searchTool?: unknown; investigationId?: unknown } | undefined;
check('persisted policy marker uses the existing provider field',
  config?.provider === CONFIGURED_DEFAULT_PROVIDER, JSON.stringify(config));
check('persisted tool is the registered web_search', config?.searchTool === 'web_search', JSON.stringify(config));

const requestId = /requestId ([0-9a-f-]{36})/.exec(sent[0] ?? '')?.[1];
check('tool handoff carries one request ID', !!requestId, sent.join(' | '));
const db = new Ledger(join(dir, 'pi-research', 'allowances.sqlite'));
const request = requestId ? db.getRequest(requestId) : undefined;
check('authorized request binds the marker and tool without a named provider',
  request?.provider === CONFIGURED_DEFAULT_PROVIDER && request.searchTool === 'web_search', JSON.stringify(request));
check('authorized request keeps the start kind and investigation identity',
  request?.kind === 'start' && request.investigationId === config?.investigationId, JSON.stringify(request));
db.close();
rmSync(dir, { recursive: true, force: true });

// ------------------------------------------------- configured-default normalization

const reply = (item: Record<string, unknown>) => ({
  responseId: 'response-1',
  fetchId: null,
  queries: [{ query, answer: 'Generated answer text.', error: null, ...item }],
});
const hit = (name: string) => ({ title: name, url: `https://${name}.test/page`, snippet: `snippet ${name}` });

const aggregate = normalizeConfiguredDiscovery(reply({
  provider: 'all', providers: ['brave', 'exa'],
  results: [
    { title: 'A', url: 'https://a.test/x#fragment', snippet: 'sa' },
    { title: 'B', url: 'https://b.test/', snippet: 'sb' },
    { title: 'A duplicate', url: 'https://a.test/x', snippet: 'sa again' },
    { title: 'Not web', url: 'ftp://c.test/file', snippet: 'sc' },
    { title: 'D', url: 'https://d.test/?u=1&v=2', snippet: 'sd' },
  ],
}), query);
check('aggregate reply keeps truthful joined provider provenance', aggregate.provider === 'brave,exa', aggregate.provider);
check('aggregate reply has no ranking', aggregate.rankingKind === 'unknown', aggregate.rankingKind);
check('aggregate reply carries no rank on any hit', aggregate.results.every(entry => entry.rank === undefined),
  JSON.stringify(aggregate.results));
check('aggregate reply deduplicates normalized URLs and keeps the requested order',
  aggregate.results.map(entry => entry.url).join(' ') === 'https://a.test/x https://b.test/ https://d.test/?u=1&v=2',
  JSON.stringify(aggregate.results.map(entry => entry.url)));
check('provider answer is never ingested as a discovery field', !('answer' in aggregate) && !('queries' in aggregate));
check('hits expose only URL/title/snippet metadata',
  aggregate.results.every(entry => Object.keys(entry).sort().join(',') === 'snippet,title,url'),
  JSON.stringify(aggregate.results[0]));

const brave = normalizeConfiguredDiscovery(reply({
  provider: 'brave', providers: ['brave'],
  results: [hit('a'), { title: 'Local', url: 'not a url', snippet: 's' }, hit('b'), { ...hit('a'), title: 'A again' }],
}), query);
check('single resolved Brave reply keeps provider-returned rank',
  brave.rankingKind === 'ranked' && brave.provider === 'brave', JSON.stringify({ kind: brave.rankingKind, provider: brave.provider }));
check('ranks follow original reply positions after invalid/duplicate skips',
  brave.results.map(entry => `${entry.title}:${entry.rank ?? '-'}`).join(' ') === 'a:1 b:3',
  JSON.stringify(brave.results));

const gemini = normalizeConfiguredDiscovery(reply({ provider: 'gemini', providers: ['gemini'], results: [hit('a'), hit('b')] }), query);
check('single resolved grounded-answer provider is a citation list without ranks',
  gemini.rankingKind === 'citation-list' && gemini.results.every(entry => entry.rank === undefined), gemini.rankingKind);

const unlabeled = normalizeConfiguredDiscovery(reply({ results: [hit('a'), hit('b')] }), query);
check('missing provider identity is unknown and unranked',
  unlabeled.provider === 'unknown' && unlabeled.rankingKind === 'unknown'
  && unlabeled.results.every(entry => entry.rank === undefined), JSON.stringify(unlabeled));

const allLabelSingle = normalizeConfiguredDiscovery(reply({ provider: 'all', providers: ['exa'], results: [hit('a')] }), query);
check('an aggregate label never acquires a provider ranking',
  allLabelSingle.provider === 'exa' && allLabelSingle.rankingKind === 'unknown', JSON.stringify(allLabelSingle));

check('a concrete provider contradicting the reported list is rejected',
  threw(() => normalizeConfiguredDiscovery(reply({ provider: 'brave', providers: ['exa'], results: [hit('a')] }), query)) === 'Provider binding changed');
check('a changed query binding is rejected',
  threw(() => normalizeConfiguredDiscovery(reply({ provider: 'brave', providers: ['brave'], results: [hit('a')] }), 'different query')) !== '');
check('a malformed provider list is rejected',
  threw(() => normalizeConfiguredDiscovery({ queries: [{ query, error: null, provider: 'all', providers: [], results: [] }] }, query)) !== ''
  && threw(() => normalizeConfiguredDiscovery({ queries: [{ query, error: null, providers: ['brave,exa'], results: [hit('a')] }] }, query)) !== ''
  && threw(() => normalizeConfiguredDiscovery({ queries: [{ query, error: null, providers: ['brave', 'brave'], results: [hit('a')] }] }, query)) !== ''
  && threw(() => normalizeConfiguredDiscovery({ queries: [{ query, error: null, providers: [1], results: [hit('a')] }] }, query)) !== '');
check('a malformed hit keeps failing closed',
  threw(() => normalizeConfiguredDiscovery({ queries: [{ query, error: null, provider: 'brave', providers: ['brave'], results: [{ title: 'x', url: 'https://x.test/' }] }] }, query)) !== '');

// ------------------------------------------------- explicit bindings unchanged

check('explicit binding still rejects an aggregate reply',
  threw(() => normalizeDiscovery(reply({ provider: 'all', providers: ['brave', 'exa'], results: [hit('a')] }), query, 'brave'))
    === 'Provider binding changed');
check('explicit binding still rejects a different reported provider',
  threw(() => normalizeDiscovery(reply({ provider: 'exa', providers: ['exa'], results: [hit('a')] }), query, 'brave'))
    === 'Provider binding changed');
const explicit = normalizeDiscovery(reply({ provider: 'brave', providers: ['brave'], results: [hit('a'), hit('b')] }), query, 'brave');
check('explicit single-provider binding keeps provider and rank',
  explicit.provider === 'brave' && explicit.rankingKind === 'ranked'
  && explicit.results.map(entry => entry.rank).join(',') === '1,2', JSON.stringify(explicit));

if (failures.length) {
  console.log(`\n${failures.length} failed check(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
