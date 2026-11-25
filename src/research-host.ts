/**
 * Hosts a /research run in a child Pi session.
 *
 * The run's model turns, prompts and evidence never enter the parent session: the child owns
 * them, writes the report, and streams back only progress. The user can resume the child
 * session to read the internals.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** What a run did, written by the child and read by the parent's viewer. */
export interface ResearchJournal {
	question: string;
	sessionFile?: string;
	status: "running" | "complete" | "stopped";
	startedAt: number;
	finishedAt?: number;
	rounds: { round: number; queries: string[]; sources: { title: string; url: string; credibility?: string }[]; failures: string[]; passages: number; totalSources: number }[];
	assessments: { round: number; answered: number; total: number; continueSearching: boolean; reason?: string; reply?: string }[];
	inspections: { id: string; sourceId: string; start: number; end: number; terms?: string[] }[];
	/** Pages a delegated agent found, fetched into the library so they could be cited. */
	delegations?: { round: number; added: { url: string; title: string; passages: number }[]; failed: { url: string; reason: string }[]; skipped?: { url: string; reason: string }[]; harvested?: string[] }[];
	stopReason?: string;
	reportPath?: string;
}

/** Pull candidate page URLs out of a delegated agent's prose reply. */
export function harvestUrls(text: string, limit = 12): string[] {
	const found = (text.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? []).map((raw) => raw.replace(/[.,;:)\]}]+$/, ""));
	return [...new Set(found)].slice(0, limit);
}

/** URLs from a delegated reply that are not already queued, capped. */
export function queueUrls(text: string, pending: readonly string[], limit = 12): string[] {
	const seen = new Set(pending);
	return harvestUrls(text, limit).filter((url) => !seen.has(url));
}

/** Render a journal as plain lines for the pager. */
export function formatJournal(journal: ResearchJournal): string[] {
	const lines: string[] = [];
	const elapsed = Math.max(0, Math.round(((journal.finishedAt ?? Date.now()) - journal.startedAt) / 1000));
	lines.push(`Question: ${journal.question}`);
	lines.push(`Status: ${journal.status} \u00b7 ${journal.rounds.length} round${journal.rounds.length === 1 ? "" : "s"} \u00b7 ${journal.rounds.at(-1)?.totalSources ?? 0} sources \u00b7 ${elapsed}s`);
	if (journal.reportPath) lines.push(`Report: ${journal.reportPath}`);
	if (journal.sessionFile) lines.push(`Child session: ${journal.sessionFile}`);
	lines.push("", "Rounds");
	if (!journal.rounds.length) lines.push("  (no round finished)");
	for (const round of journal.rounds) {
		lines.push(`  Round ${round.round} \u00b7 ${round.queries.length} queries \u00b7 ${round.sources.length} new \u00b7 ${round.passages} passages${round.failures.length ? ` \u00b7 ${round.failures.length} failed` : ""}`);
		for (const query of round.queries) lines.push(`    query: ${query}`);
		for (const source of round.sources) lines.push(`    source: ${source.title || "(untitled)"} \u2014 ${source.url}${source.credibility ? ` [${source.credibility}]` : ""}`);
		for (const failure of round.failures) lines.push(`    failed: ${failure}`);
	}
	if (journal.assessments.length) {
		lines.push("", "Assessments");
		for (const entry of journal.assessments) {
			lines.push(`  Round ${entry.round}: ${entry.answered}/${entry.total} needs answered \u00b7 continue=${entry.continueSearching}${entry.reason ? ` \u00b7 ${entry.reason}` : ""}`);
			for (const line of (entry.reply ?? "").split("\n")) lines.push(`    | ${line}`);
		}
	}
	if (journal.inspections.length) {
		lines.push("", "Inspections");
		for (const entry of journal.inspections) {
			lines.push(`  ${entry.id} \u00b7 ${entry.sourceId} \u00b7 offsets ${entry.start}\u2013${entry.end}${entry.terms?.length ? ` \u00b7 terms ${entry.terms.join(", ")}` : ""}`);
		}
	}
	if (journal.delegations?.length) {
		lines.push("", "Delegated sources");
		for (const entry of journal.delegations) {
			for (const source of entry.added) lines.push(`  Round ${entry.round} \u00b7 added ${source.passages} passage${source.passages === 1 ? "" : "s"}: ${source.title || "(untitled)"} \u2014 ${source.url}`);
			for (const failure of entry.failed) lines.push(`  Round ${entry.round} \u00b7 failed: ${failure.url} \u2014 ${failure.reason}`);
			for (const skip of entry.skipped ?? []) lines.push(`  Round ${entry.round} \u00b7 skipped: ${skip.url} \u2014 ${skip.reason}`);
			for (const url of entry.harvested ?? []) lines.push(`  Round ${entry.round} \u00b7 queued from a delegated reply: ${url}`);
		}
	}
	if (journal.stopReason) lines.push("", `Stop: ${journal.stopReason}`);
	return lines;
}

export interface HostOptions {
	question: string;
	cwd: string;
	reportFile: string;
	extensionPath?: string;
	onProgress?: (lines: string[]) => void;
	onNotify?: (message: string, level: "info" | "warning" | "error") => void;
	onSettled?: (summary: { path?: string; detail?: string; journal?: string; exitCode: number | null }) => void;
}

export interface HostedRun {
	stop(): void;
	readonly pid: number | undefined;
}

const SELF = fileURLToPath(new URL("./research.ts", import.meta.url));

/** Spawn one child session for a question and mirror its progress back. */
export function hostResearch(options: HostOptions): HostedRun {
	const args = [
		"--mode", "rpc",
		"-ne",
		"-e", options.extensionPath ?? SELF,
		"-e", process.env.PI_RESEARCH_TOOLS_EXT ?? "npm:pi-web-access",
		"--thinking", "off",
	];
	// The run may delegate a need to a subagent; without this extension it simply cannot.
	const subagents = process.env.PI_RESEARCH_SUBAGENTS_EXT ?? "npm:@gotgenes/pi-subagents";
	if (subagents) args.push("-e", subagents);
	// Scanned papers carry no extractable text: the parser is what makes them readable at all.
	const parser = process.env.PI_RESEARCH_OCR_EXT ?? "npm:pi-docparser";
	if (parser) args.push("-e", parser);
	// Optional pin for the research session's model, as "provider/id".
	const pinned = process.env.PI_RESEARCH_MODEL?.trim();
	if (pinned) {
		const slash = pinned.indexOf("/");
		if (slash > 0) args.push("--provider", pinned.slice(0, slash), "--model", pinned.slice(slash + 1));
	}
	const child: ChildProcessWithoutNullStreams = spawn(process.env.PI_BIN ?? "pi", args, {
		cwd: options.cwd,
		env: {
			...process.env,
			PI_RESEARCH_CHILD: "1",
			PI_RESEARCH_QUESTION: options.question,
			PI_RESEARCH_REPORT_FILE: options.reportFile,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	let buffer = "";
	let stderr = "";
	let settled = false;

	const handle = (record: Record<string, unknown>) => {
		if (record.type === "extension_ui_request") {
			if (record.method === "setWidget" && Array.isArray(record.widgetLines)) {
				options.onProgress?.(record.widgetLines as string[]);
				return;
			}
			if (record.method === "notify" && typeof record.message === "string") {
				const level = record.notifyType === "error" || record.notifyType === "warning" ? record.notifyType : "info";
				options.onNotify?.(record.message, level);
				return;
			}
		}
	};

	// Strict JSONL framing: split on LF only, never on Unicode separators.
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line.trim()) continue;
			try {
				handle(JSON.parse(line) as Record<string, unknown>);
			} catch {
				/* a torn or non-JSON line is not protocol data */
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
	});

	const finish = (exitCode: number | null) => {
		if (settled) return;
		settled = true;
		const summary: { path?: string; detail?: string; journal?: string; exitCode: number | null } = { exitCode };
		if (existsSync(options.reportFile)) {
			try {
				const saved = JSON.parse(readFileSync(options.reportFile, "utf8")) as { path?: string; detail?: string; journal?: string };
				summary.path = saved.path;
				summary.detail = saved.detail;
				summary.journal = saved.journal;
			} catch {
				/* the child writes this file last; a torn read just means no summary */
			}
		}
		if (!summary.path && exitCode !== 0) summary.detail = summary.detail ?? stderr.trim().split("\n").slice(-3).join(" ");
		options.onSettled?.(summary);
	};

	child.on("error", (error) => {
		stderr = `${stderr}\n${error.message}`.trim();
		finish(null);
	});
	child.on("close", (code) => finish(code));

	return {
		pid: child.pid,
		stop() {
			if (settled) return;
			try {
				// Ask for an orderly shutdown first; the child saves collected evidence on abort.
				child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
				child.stdin.end();
			} catch {
				/* already gone */
			}
			// Give the child time to write its evidence and the report signal before any signal.
			setTimeout(() => {
				if (!settled) child.kill("SIGTERM");
			}, 5000).unref();
		},
	};
}
