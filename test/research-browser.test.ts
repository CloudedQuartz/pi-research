import assert from "node:assert/strict";
import { test } from "node:test";
import { BROWSER_USER_AGENT, browserEnabled, usableBrowserText } from "../src/research-browser.js";

test("the user agent a person's browser would send is used, not a bot string", () => {
	assert.doesNotMatch(BROWSER_USER_AGENT, /headless/i);
	assert.doesNotMatch(BROWSER_USER_AGENT, /bot|crawler/i);
	assert.match(BROWSER_USER_AGENT, /Chrome\/\d+\.0\.0\.0/);
});

test("the browser rung is off unless it is asked for", () => {
	assert.equal(browserEnabled({}), false);
	assert.equal(browserEnabled({ PI_RESEARCH_BROWSER: "0" }), false);
	assert.equal(browserEnabled({ PI_RESEARCH_BROWSER: "1" }), true);
	assert.equal(browserEnabled({ PI_RESEARCH_BROWSER: "true" }), true);
});

test("a challenge page is not mistaken for an article", () => {
	assert.equal(usableBrowserText("Just a moment..."), undefined);
	assert.equal(usableBrowserText("x".repeat(400)), undefined);
});

test("rendered text is trimmed and capped", () => {
	const long = "Sentence. ".repeat(60_000);
	const kept = usableBrowserText(long);
	assert.ok(kept && kept.length <= 400_000);
	const messy = `Title\n\n\n\n${"Body text that is long enough to keep. ".repeat(20)}\n`;
	assert.equal(usableBrowserText(messy)?.includes("\n\n\n"), false);
});
