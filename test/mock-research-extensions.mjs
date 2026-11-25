/**
 * Offline fixtures for test/research-rpc.mjs.
 *
 * Registers a local OpenAI-compatible provider (base URL passed in
 * MOCK_BASE_URL) plus mock web-search, page-read, and passage tools with the
 * same names and result shapes used by pi-web-access. No real network access,
 * provider credentials, or paid calls are involved.
 */

const SEARCH_ID = "mock-search-1";
const FETCH_ID = "mock-fetch-1";

const PAGES = {
	"https://example.org/case-a": `Mock Case A: a municipal utility reported a 12% reduction in non-revenue water after deploying acoustic sensors in 2022. The reported realized saving was 1.8 million USD over two years, against a 0.9 million USD programme cost. The baseline was the 2019-2021 average, and the utility says the result is measured from billed consumption rather than a projection.`,
	"https://example.org/case-b": `Mock Case B: a second utility piloted satellite leak detection in 2023. It reported 40 confirmed leaks in the first six months and an estimated 0.7 million USD annual saving. The estimate is modelled from avoided water production, not yet verified against billed consumption; the programme cost was 0.4 million USD.`,
	"https://example.org/verification": `Mock Verification: an independent review compared Case A and Case B. It found Case A's realized outcome was supported by two years of billing records, while Case B's saving remained a projection. The review warned that the two utilities use different water-loss definitions and different price assumptions, so their savings should not be ranked as one measure.`,
};

export default function mockResearchExtensions(pi) {
	pi.registerProvider("mock-research", {
		name: "Mock Research",
		baseUrl: process.env.MOCK_BASE_URL,
		apiKey: "mock-test-key",
		api: "openai-completions",
		models: [
			{
				type: "chat",
				id: "mock-research",
				name: "Mock Research",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 64000,
				maxTokens: 8192,
			},
		],
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for sources or answers. Full results are stored for retrieval with get_search_content by responseId.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string" },
				queries: { type: "array", items: { type: "string" } },
				numResults: { type: "integer" },
				includeContent: { type: "boolean" },
				recencyFilter: { type: "string" },
				domainFilter: { type: "array", items: { type: "string" } },
			},
			additionalProperties: true,
		},
		async execute(_toolCallId, params) {
			const queries = Array.isArray(params.queries) ? params.queries : [params.query ?? "mock query"];
			return {
				content: [
					{
						type: "text",
						text: `Mock search results for ${queries.join(" | ")}:\n1. Mock Case A - https://example.org/case-a\n   Snippet: acoustic sensors and realized non-revenue water savings.\n2. Mock Case B - https://example.org/case-b\n   Snippet: satellite pilot and estimated savings.\n3. Mock Verification - https://example.org/verification\n   Snippet: independent comparison of realized versus projected savings.\n\nFull search results are stored as responseId "${SEARCH_ID}".`,
					},
				],
				details: { responseId: SEARCH_ID, queries },
			};
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch web pages, PDFs, GitHub repos, images, YouTube and local video, as the mode allows.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string" },
				urls: { type: "array", items: { type: "string" } },
				mode: { type: "string" },
				prompt: { type: "string" },
			},
			additionalProperties: true,
		},
		async execute(_toolCallId, params) {
			const urls = Array.isArray(params.urls) ? params.urls : [params.url ?? "https://example.org/case-a"];
			const body = urls
				.map((url) => `# ${url}\n${PAGES[url] ?? "Mock unreadable page."}`)
				.join("\n\n---\n\n");
			return {
				content: [
					{
						type: "text",
						text: `${body}\n\n---\nThe fetched pages are stored as responseId "${FETCH_ID}". Use get_search_content with this responseId to find exact passages.`,
					},
				],
				details: { responseId: FETCH_ID, urls, successful: urls.length },
			};
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Page through or search stored content from web_search or fetch_content by responseId.",
		parameters: {
			type: "object",
			properties: {
				responseId: { type: "string" },
				url: { type: "string" },
				urlIndex: { type: "integer" },
				offset: { type: "integer" },
				limit: { type: "integer" },
				findText: {
					type: ["string", "array"],
					items: { type: "string" },
				},
				findMode: { type: "string" },
			},
			required: ["responseId"],
			additionalProperties: true,
		},
		async execute(_toolCallId, params) {
			const needles = Array.isArray(params.findText)
				? params.findText
				: params.findText
					? [params.findText]
					: [];
			const quoted = needles.length ? `"${needles[0]}"` : '"realized savings"';
			return {
				content: [
					{
						type: "text",
						text: `Mock passage hits for responseId ${params.responseId}:\n- "${quoted}" appears in https://example.org/case-a: "The reported realized saving was 1.8 million USD over two years, against a 0.9 million USD programme cost."\n- "${quoted}" appears in https://example.org/verification: "Case A's realized outcome was supported by two years of billing records, while Case B's saving remained a projection."`,
					},
				],
				details: { responseId: params.responseId, findText: needles },
			};
		},
	});

	pi.registerTool({
		name: "source_check",
		label: "Source Check",
		description: "Gather cited web passages about a claim for manual review.",
		parameters: {
			type: "object",
			properties: {
				claim: { type: "string" },
				queries: { type: "array", items: { type: "string" } },
				fetchContent: { type: "boolean" },
			},
			required: ["claim"],
			additionalProperties: true,
		},
		async execute(_toolCallId, params) {
			return {
				content: [
					{
						type: "text",
						text: `Mock source check for "${params.claim}": https://example.org/verification says Case A used billing records and Case B remained a projection.`,
					},
				],
				details: { claim: params.claim },
			};
		},
	});
}
