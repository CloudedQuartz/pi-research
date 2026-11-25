import assert from "node:assert/strict";
import { test } from "node:test";
import { providerRetryDelay } from "../src/research-loop.js";

test("a rate limit backs off, and the wait grows with each attempt", () => {
	assert.equal(providerRetryDelay("429: {\"type\":\"rate_limit_error\"}", 1), 20_000);
	assert.equal(providerRetryDelay("429: rate limit exceeded", 2), 40_000);
	assert.equal(providerRetryDelay("429", 3), 80_000);
	assert.equal(providerRetryDelay("429", 4), 120_000, "capped, so a run cannot stall indefinitely");
});

test("transient server and timeout errors are retryable too", () => {
	for (const reason of ["503 Service Unavailable", "502 bad gateway", "overloaded", "Too Many Requests", "Read timed out"]) {
		assert.notEqual(providerRetryDelay(reason, 1), undefined, reason);
	}
});

test("a permanent error is not retried, so a bad key fails fast", () => {
	for (const reason of ["401: unauthorized", "invalid api key", "400: prompt is too long", "content_policy_violation"]) {
		assert.equal(providerRetryDelay(reason, 1), undefined, reason);
	}
	assert.equal(providerRetryDelay(undefined, 1), undefined);
});
