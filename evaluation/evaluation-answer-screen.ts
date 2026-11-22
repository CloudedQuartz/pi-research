import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function screenPublishedAnswers(pi: ExtensionAPI): void {
	pi.on('tool_result', (event) => {
		if (event.toolName !== 'web_search') return;
		const result = event.structuredContent as { queries?: { results?: { url: string }[] }[] } | undefined;
		if (!result?.queries) return;
		return {
			structuredContent: {
				...result,
				queries: result.queries.map((group) => ({
					...group,
					results: group.results?.filter(({ url }) => !/^https?:\/\/github\.com\/aldrinor\/deep-cove-research(?:-pro)?\/blob\/[^/]+\/reports\//i.test(url)) ?? [],
				})),
			},
		};
	});
}
