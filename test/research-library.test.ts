/**
 * Offline regression for /research's use of the IR core: segment() passages with exact
 * offsets, Porter-stemmed BM25 + MMR retrieval with the per-source cap, and the pre-fetch
 * Naive Bayes candidate filter trained from the assessment. No model or network calls.
 *
 * Run: ./node_modules/.bin/tsx test/research-library.test.ts   (exit 1 on any failed check)
 */
import { EvidenceLibrary } from '../src/research-library.js';
import { ResearchLoop } from '../src/research-loop.js';

const failures: string[] = [];
const check = (label: string, condition: boolean): void => {
  if (condition) console.log(`ok   ${label}`);
  else { failures.push(label); console.log(`FAIL ${label}`); }
};

const leaks = Array.from({ length: 12 }, (_, i) =>
  `Utility ${i} deployed acoustic sensors on distribution mains. The loggers detected leaks early, crews repaired the leaking pipes, and the utility reported lower non-revenue water and avoided excavation costs over the following year.`,
).join('\n\n');
const pasta = Array.from({ length: 6 }, () =>
  'Boil the pasta in salted water, then toss it with tomato sauce, garlic, olive oil and fresh basil. Serve the pasta recipe with grated parmesan and a green salad for a simple weeknight dinner at home.',
).join('\n\n');

// Retrieval: stemming matches "leak detection" to "leaks detected"; offsets reproduce the text.
const library = new EvidenceLibrary();
library.addSource({ url: 'https://utility.example/leaks', title: 'Leak programme', text: leaks, retrievedAt: '2026-11-22T00:00:00Z' });
library.addSource({ url: 'https://food.example/pasta', title: 'Pasta', text: pasta, retrievedAt: '2026-11-22T00:00:00Z' });
const hits = library.retrieve('leak detection economic outcomes');
check('stemmed BM25 retrieves passages for an inflected query', hits.length > 0 && hits.every(hit => hit.passage.sourceId.includes('utility.example')));
check('every passage reproduces its source span exactly', library.passages.every(p => library.sources.get(p.sourceId)!.text.slice(p.start, p.end) === p.text));
check('at most two passages per source', hits.length <= 2);
check('an unrelated query retrieves nothing', library.retrieve('quantum chromodynamics lattice').length === 0);

// Candidate filter: inactive before the first assessment, then drops confident off-topic hits.
const loop = new ResearchLoop();
loop.plan(JSON.stringify({ needs: [{ question: 'What economic outcomes do utilities report from acoustic leak detection?', essential: true, queries: ['acoustic leak detection utility savings'] }] }));
const groups = () => [
  { query: 'q1', results: [{ url: 'https://food.example/recipes/pasta-tomato', title: 'Pasta recipe', snippet: 'Boil pasta, tomato sauce, garlic, basil and parmesan for dinner' }] },
  { query: 'q2', results: [{ url: 'https://water.example/news/acoustic-leak-savings', title: 'Acoustic leak detection savings', snippet: 'Utility sensors detected leaks and reduced non-revenue water' }] },
];
check('first round is not filtered (no off-topic examples yet)', new ResearchLoop().selectUrls(groups()).length === 2);
loop.markSearched(loop.pendingQueries());
loop.library.addSource({ url: 'https://utility.example/leaks', title: 'Leak programme', text: leaks, retrievedAt: '2026-11-22T00:00:00Z' });
loop.library.addSource({ url: 'https://food.example/pasta', title: 'Pasta', text: pasta, retrievedAt: '2026-11-22T00:00:00Z' });
const packet = loop.evidence();
const cited = packet.needs[0]!.passages.slice(0, 1);
loop.assess(JSON.stringify({ needs: [{ id: 1, answered: true, passages: cited }], continueSearching: false, reason: 'done' }), packet, false);
const selected = loop.selectUrls(groups());
check('Naive Bayes keeps the on-topic candidate', selected.includes('https://water.example/news/acoustic-leak-savings'));
check('Naive Bayes drops the off-topic candidate before fetch', !selected.includes('https://food.example/recipes/pasta-tomato')
  && loop.filtered.some(entry => entry.url === 'https://food.example/recipes/pasta-tomato'));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
