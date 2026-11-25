/**
 * Retrieval evaluation over the corpus a /research run actually collected.
 *
 * Queries are the run's research needs; the corpus is every passage the run stored;
 * the ranking is the production retriever (EvidenceLibrary.retrieve: BM25 then MMR).
 * Relevance labels come from the judge model and are cached beside the evidence file,
 * so a rerun is offline and free. Metrics follow riyaa42's scripts/evaluate.ts on the
 * earlier branch - MAP, R-Precision, BPref (Buckley & Voorhees, 2004) and nDCG@10.
 *
 * Usage: tsx scripts/retrieval-eval.ts <evidence.json|dir>...
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { EvidenceLibrary } from "../src/research-library.js";

const ENDPOINT = process.env.JUDGE_ENDPOINT ?? "http://127.0.0.1:8787/v1/chat/completions";
const MODEL = process.env.JUDGE_MODEL ?? "deepseek-v4.1-flash";

interface Evidence {
	question: string;
	needs: { id: number; question: string }[];
	sources: { url: string; title: string; text: string }[];
}
type Judgments = Record<number, Record<string, number>>;

const key = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);

/** Labels arrive as a JSON object of passage key -> 0|1|2; anything unparseable means no labels. */
async function label(need: string, passages: { id: string; text: string }[]): Promise<Record<string, number>> {
	const list = passages
		.map((p) => `[${p.id}] ${p.text.replace(/\s+/g, " ").slice(0, 320)}`)
		.join("\n");
	const prompt = `A researcher asked: ${need}

Below are passages from a document collection. For each, decide how much it helps answer that question:
2 = directly answers it, 1 = partly relevant or useful context, 0 = not relevant.

${list}

Reply with JSON only: {"<passage id>": <0|1|2>, ...} for every passage listed.`;
	const response = await request(prompt);
	const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
	const text = body.choices?.[0]?.message?.content ?? "";
	const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
	const parsed = JSON.parse(json) as Record<string, number>;
	const out: Record<string, number> = {};
	for (const [id, grade] of Object.entries(parsed)) {
		const value = Number(grade);
		if (Number.isFinite(value)) out[id] = Math.max(0, Math.min(2, value));
	}
	return out;
}

/** Judge calls share a rate limit with the research runs, so a 429 backs off rather than aborting. */
async function request(prompt: string): Promise<Response> {
	let lastError = "";
	for (let attempt = 1; attempt <= 5; attempt++) {
		try {
			const response = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${process.env.JUDGE_KEY ?? ""}` },
				body: JSON.stringify({ model: MODEL, temperature: 0, messages: [{ role: "user", content: prompt }] }),
				signal: AbortSignal.timeout(240_000),
			});
			if (response.ok) return response;
			lastError = `judge ${response.status}`;
			if (response.status !== 429 && response.status < 500) throw new Error(lastError);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 20_000 * attempt));
	}
	throw new Error(lastError || "judge call failed");
}

/** MAP, R-Precision, BPref and nDCG@10 for one ranking, ported from her evaluate.ts. */
function metrics(ids: string[], judgments: Record<string, number>) {
	const grade = (id: string) => (Object.hasOwn(judgments, id) ? (judgments[id] ?? 0) : 0);
	const relevant = (id: string) => grade(id) > 0;
	const gain = (grades: number[]) => grades.reduce((sum, value, index) => sum + (2 ** value - 1) / Math.log2(index + 2), 0);
	const ideal = gain(Object.values(judgments).sort((a, b) => b - a).slice(0, 10));
	const dcg = gain(ids.slice(0, 10).map(grade));
	const positives = Object.values(judgments).filter((v) => v > 0).length;
	const negatives = Object.values(judgments).filter((v) => v === 0).length;

	let seen = 0;
	let apSum = 0;
	ids.forEach((id, index) => {
		if (relevant(id)) apSum += ++seen / (index + 1);
	});
	const map = positives ? apSum / positives : 0;
	const rPrec = positives ? ids.slice(0, positives).filter(relevant).length / positives : 0;

	let nonrelAbove = 0;
	let bprefSum = 0;
	const denom = Math.min(positives, Math.max(negatives, 1));
	for (const id of ids) {
		if (!Object.hasOwn(judgments, id)) continue;
		if ((judgments[id] ?? 0) > 0) bprefSum += 1 - Math.min(nonrelAbove, positives) / denom;
		else nonrelAbove++;
	}
	const bpref = positives ? Math.max(0, bprefSum / positives) : 0;
	const ndcg = ideal > 0 ? dcg / ideal : 0;
	return { map, rPrec, bpref, ndcg, positives };
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

async function expand(args: string[]): Promise<string[]> {
	const files: string[] = [];
	for (const arg of args) {
		const info = await stat(arg);
		if (info.isDirectory()) {
			for (const name of await readdir(arg)) if (name.endsWith(".evidence.json")) files.push(join(arg, name));
		} else files.push(arg);
	}
	return files;
}

async function main(): Promise<void> {
	if (!process.env.JUDGE_KEY) throw new Error("JUDGE_KEY is not set");
	const files = await expand(process.argv.slice(2));
	if (!files.length) throw new Error("no evidence files given");
	console.log("| evidence file | needs | passages | nDCG@10 | MAP | R-Prec | BPref |");
	console.log("|---|---:|---:|---:|---:|---:|---:|");
	const all: { ndcg: number; map: number; rPrec: number; bpref: number }[] = [];
	for (const file of files) {
		const evidence = JSON.parse(readFileSync(file, "utf8")) as Evidence;
		const library = new EvidenceLibrary();
		for (const source of evidence.sources)
			library.addSource({ url: source.url, title: source.title, text: source.text, retrievedAt: new Date(0).toISOString() });
		const cachePath = file.replace(/\.json$/, ".qrels.json");
		const cache: Judgments = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as Judgments) : {};
		let dirty = false;
		const rows: { ndcg: number; map: number; rPrec: number; bpref: number }[] = [];
		for (const need of evidence.needs) {
			const hits = library.retrieve(need.question, 400, 400);
			if (!hits.length) continue;
			const passages = hits.map((hit) => ({ id: key(hit.passage.text), text: hit.passage.text }));
			if (!cache[need.id]) {
				cache[need.id] = await label(need.question, passages);
				dirty = true;
			}
			const result = metrics(passages.map((p) => p.id), cache[need.id]!);
			if (result.positives > 0) rows.push(result);
		}
		if (dirty) writeFileSync(cachePath, JSON.stringify(cache, null, 2));
		const row = { ndcg: mean(rows.map((r) => r.ndcg)), map: mean(rows.map((r) => r.map)), rPrec: mean(rows.map((r) => r.rPrec)), bpref: mean(rows.map((r) => r.bpref)) };
		all.push(row);
		const name = file.split("/").slice(-2).join("/");
		console.log(`| ${name} | ${rows.length} | ${library.passages.length} | ${row.ndcg.toFixed(3)} | ${row.map.toFixed(3)} | ${row.rPrec.toFixed(3)} | ${row.bpref.toFixed(3)} |`);
	}
	console.log(`\n**mean** (${all.length} runs): nDCG@10 ${mean(all.map((r) => r.ndcg)).toFixed(3)}, MAP ${mean(all.map((r) => r.map)).toFixed(3)}, R-Prec ${mean(all.map((r) => r.rPrec)).toFixed(3)}, BPref ${mean(all.map((r) => r.bpref)).toFixed(3)}`);
}

await main();
