import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPublicTarget, classifyFetchFailure, type AcquisitionResolver } from "../src/research-acquisition.js";

const resolvesTo = (address: string): AcquisitionResolver => async () => [{ address, family: address.includes(":") ? 6 : 4 }];

test("a bot wall is told apart from a dead link", () => {
	assert.equal(classifyFetchFailure("HTTP 403: Forbidden"), "blocked");
	assert.equal(classifyFetchFailure("429 Too Many Requests"), "blocked");
	assert.equal(classifyFetchFailure("Cloudflare challenge"), "blocked");
	assert.equal(classifyFetchFailure("<title>Just a moment...</title>"), "blocked");
	assert.equal(classifyFetchFailure("Failed to resolve www.ib-net.org: getaddrinfo ENOTFOUND"), "failed");
	assert.equal(classifyFetchFailure("Read timed out after 60s"), "failed");
	assert.equal(classifyFetchFailure("document parse produced no text"), "failed");
});

test("private and link-local targets are refused before any fetch", async () => {
	for (const url of ["http://127.0.0.1/admin", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://localhost:8080/"]) {
		const check = await checkPublicTarget(url, { resolver: resolvesTo("127.0.0.1") });
		assert.equal(check.ok, false, `${url} should be refused`);
		assert.match(check.reason ?? "", /rejected|Non-public|Invalid IP/i);
	}
});

test("a public address is allowed and a private one behind a hostname fails closed", async () => {
	assert.equal((await checkPublicTarget("https://example.com/a", { resolver: resolvesTo("93.184.216.34") })).ok, true);
	const privateHost = await checkPublicTarget("https://looks-fine.example/x", { resolver: resolvesTo("192.168.1.10") });
	assert.equal(privateHost.ok, false);
	assert.match(privateHost.reason ?? "", /Non-public/i);
});

test("non-http schemes and junk are refused", async () => {
	assert.equal((await checkPublicTarget("file:///etc/passwd", { resolver: resolvesTo("93.184.216.34") })).ok, false);
	assert.equal((await checkPublicTarget("not a url", { resolver: resolvesTo("93.184.216.34") })).ok, false);
});
