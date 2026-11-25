/**
 * A last rung for pages that refuse a plain fetch and have no archived copy.
 *
 * Two things make this work where a naive headless request does not: the User-Agent must not
 * contain the `HeadlessChrome` token (that single correction cleared 75% of 403s in the
 * measurement this module was built from), and the browser must look like the one a person runs.
 * It is opt-in because it costs a real browser launch, and it is skipped silently when
 * playwright-core is absent so the package still installs without it.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A headed Chrome UA string. The version is cosmetic; the absence of `HeadlessChrome` is not. */
export const BROWSER_USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

/** Pages beyond this are truncated: the corpus wants the article, not the whole document. */
export const MAX_BROWSER_CHARS = 400_000;

export interface BrowserPage {
	url: string;
	title: string;
	content: string;
}

/** The Chromium binary, if one is present locally. */
export function browserExecutable(env: Record<string, string | undefined> = process.env): string | undefined {
	if (env.PI_RESEARCH_CHROME && existsSync(env.PI_RESEARCH_CHROME)) return env.PI_RESEARCH_CHROME;
	const cache = join(homedir(), ".cache", "ms-playwright");
	if (!existsSync(cache)) return undefined;
	// Newest revision wins; the directory names carry the build number.
	const candidates = [
		join(cache, "chromium-1255", "chrome-linux64", "chrome"),
		join(cache, "chromium-1255", "chrome-linux", "chrome"),
	];
	return candidates.find((candidate) => existsSync(candidate));
}

export function browserEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const flag = (env.PI_RESEARCH_BROWSER ?? "").toLowerCase();
	return flag === "1" || flag === "true" || flag === "yes";
}

/** Trim rendered text to the part worth keeping, and drop a page that is only a wall. */
export function usableBrowserText(text: string): string | undefined {
	const trimmed = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	if (trimmed.length < 500) return undefined;
	if (/^(just a moment|attention required|access denied|are you a robot)/i.test(trimmed)) return undefined;
	return trimmed.length > MAX_BROWSER_CHARS ? trimmed.slice(0, MAX_BROWSER_CHARS) : trimmed;
}

type PlaywrightChromium = {
	launch(options: { executablePath?: string; headless?: boolean }): Promise<{
		newPage(options: { userAgent: string }): Promise<{
			goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
			evaluate<T>(fn: () => T): Promise<T>;
			title(): Promise<string>;
			close(): Promise<void>;
		}>;
		close(): Promise<void>;
	}>;
};

/**
 * Render one page in a local Chromium and return its text. Every failure path returns undefined:
 * this rung must never be able to end a run, only to add to it.
 */
export async function readWithBrowser(url: string, timeoutMs = 45_000): Promise<BrowserPage | undefined> {
	const executablePath = browserExecutable();
	if (!executablePath) return undefined;
	let chromium: PlaywrightChromium;
	try {
		// Optional dependency: absent means the rung is simply not available. The specifier is a
		// variable so typechecking does not require the package to be installed.
		const specifier = "playwright-core";
		chromium = ((await import(specifier)) as { chromium: PlaywrightChromium }).chromium;
	} catch {
		return undefined;
	}
	let browser: Awaited<ReturnType<PlaywrightChromium["launch"]>> | undefined;
	try {
		browser = await chromium.launch({ executablePath, headless: true });
		const page = await browser.newPage({ userAgent: BROWSER_USER_AGENT });
		try {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
			const text = usableBrowserText(await page.evaluate(() => document.body?.innerText ?? ""));
			if (!text) return undefined;
			const title = await page.title();
			return { url, title: title?.trim() || url, content: text };
		} finally {
			await page.close().catch(() => undefined);
		}
	} catch {
		return undefined;
	} finally {
		await browser?.close().catch(() => undefined);
	}
}
