import assert from "node:assert/strict";
import { test } from "node:test";
import { pickAssistantReply } from "../src/research-loop.js";

const assistant = (text: string, timestamp?: string, stopReason = "stop") => ({
	type: "message",
	timestamp,
	message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
});

test("the newest assistant text is the reply", () => {
	const branch = [assistant("first"), { type: "message", message: { role: "user", content: [{ type: "text", text: "prompt" }] } }, assistant("final report")];
	assert.deepEqual(pickAssistantReply(branch), { text: "final report", stopReason: "stop" });
});

test("a turn that predates the stage prompt is not adopted", () => {
	const branch = [assistant("old report", "2026-11-25T19:00:00.000Z")];
	const since = Date.parse("2026-11-25T19:30:00.000Z");
	assert.equal(pickAssistantReply(branch, since), undefined);
});

test("a fresh turn is adopted once it is after the prompt", () => {
	const branch = [assistant("old report", "2026-11-25T19:00:00.000Z"), assistant("fresh report", "2026-11-25T19:31:00.000Z")];
	assert.deepEqual(pickAssistantReply(branch, Date.parse("2026-11-25T19:30:00.000Z")), { text: "fresh report", stopReason: "stop" });
});

test("tool-call-only turns are skipped so an empty completion is still empty", () => {
	const branch = [
		assistant("real text"),
		{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "research_round", arguments: {} }] } },
	];
	assert.deepEqual(pickAssistantReply(branch), { text: "real text", stopReason: "stop" });
});

test("a branch with no assistant text yields nothing", () => {
	assert.equal(pickAssistantReply([]), undefined);
	assert.equal(pickAssistantReply([{ type: "custom", customType: "subagent-notification" }]), undefined);
});

test("the entry timestamp is what sessions record, and it is honoured", () => {
	const branch = [
		{ type: "message", timestamp: "2026-11-25T19:00:00.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }] } },
	];
	assert.equal(pickAssistantReply(branch, Date.parse("2026-11-25T19:30:00.000Z")), undefined);
	assert.deepEqual(pickAssistantReply(branch), { text: "old", stopReason: "stop" });
});
