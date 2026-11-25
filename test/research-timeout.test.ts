import assert from "node:assert/strict";
import { test } from "node:test";
import { stageTimeoutMs } from "../src/research-loop.js";

test("no bound unless one is asked for", () => {
	assert.equal(stageTimeoutMs(undefined), 0);
	assert.equal(stageTimeoutMs(""), 0);
	assert.equal(stageTimeoutMs("0"), 0);
});

test("a nonsense or negative value does not become a bound", () => {
	assert.equal(stageTimeoutMs("abc"), 0);
	assert.equal(stageTimeoutMs("-60000"), 0);
});

test("an explicit bound is honoured in milliseconds", () => {
	assert.equal(stageTimeoutMs("1200000"), 1_200_000);
});
