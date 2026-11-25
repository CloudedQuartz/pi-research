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

export interface HostOptions {
	question: string;
	cwd: string;
	reportFile: string;
	extensionPath?: string;
	onProgress?: (lines: string[]) => void;
	onNotify?: (message: string, level: "info" | "warning" | "error") => void;
	onSettled?: (summary: { path?: string; detail?: string; exitCode: number | null }) => void;
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
		const summary: { path?: string; detail?: string; exitCode: number | null } = { exitCode };
		if (existsSync(options.reportFile)) {
			try {
				const saved = JSON.parse(readFileSync(options.reportFile, "utf8")) as { path?: string; detail?: string };
				summary.path = saved.path;
				summary.detail = saved.detail;
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
