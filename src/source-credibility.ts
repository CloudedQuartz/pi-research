/**
 * Explainable source prior: what kind of source is this, and has an independent
 * rating initiative flagged it?
 *
 * Two signals, no network calls and no API keys:
 * - CRED-1 (CC BY 4.0 dataset, MIT code, bundled): domain-level credibility from public
 *   source-rating lists. It is a prior about the outlet, not a verdict on an article, and
 *   absence from it means "unrated", never "trustworthy".
 * - Host classification: institutions and journals are raised slightly, content
 *   aggregators lowered, because a mirror of a document is not the document.
 *
 * Nothing here removes evidence. The factor reorders passages and the detail is shown to
 * the writer and recorded in the journal.
 */
import { checkDomain } from "@aloth/cred1";

export type SourceTier = "institution" | "journal" | "neutral" | "aggregator" | "low";

export interface SourceCredibility {
	tier: SourceTier;
	/** Multiplier applied to retrieval score: a prior, never a filter. */
	factor: number;
	/** Short, human-readable reason shown in the report and the journal. */
	detail: string;
}

/** Mirrors and document farms: usable as a pointer, not as the source of record. */
const AGGREGATOR_HOSTS = [
	"scribd.",
	"slidetodoc.",
	"studocu.",
	"coursehero.",
	"docsity.",
	"issuu.",
	"yumpu.",
	"pdfcoffee.",
	"idoc.pub",
	"vdocuments.",
	"dokumen.pub",
	"slideshare.",
	"academia.edu",
];

const INSTITUTION_HOST = /\.(gov|mil|edu|ac\.[a-z]{2})$/;
const JOURNAL_HOST =
	/(^|\.)(doi\.org|arxiv\.org|ncbi\.nlm\.nih\.gov|nature\.com|science\.org|sciencedirect\.com|springer\.com|link\.springer\.com|wiley\.com|onlinelibrary\.wiley\.com|mdpi\.com|ieee\.org|jstor\.org|tandfonline\.com|sagepub\.com|scielo\.br|journals\.plos\.org|cambridge\.org|oxfordacademic\.com|iwaonline\.com|wrc\.org\.za)$/;

const cache = new Map<string, SourceCredibility>();

/** Hostname without `www.`, lowercased. Empty string when the URL has no host. */
export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

function rated(host: string): { level: string; category: string; score: number; sources: number; trancoRank?: number; domainAge?: number } | null {
	try {
		return checkDomain(host);
	} catch {
		// The dataset is optional at runtime: a missing import must not break a run.
		return null;
	}
}

export function credibilityOf(url: string): SourceCredibility {
	const host = hostOf(url);
	const hit = cache.get(host);
	if (hit) return hit;

	let result: SourceCredibility;
	const rating = rated(host);
	if (rating && (rating.level === "low" || rating.level === "mixed")) {
		result = {
			tier: "low",
			factor: rating.level === "low" ? 0.6 : 0.85,
			detail: `CRED-1 rates this outlet ${rating.level} (${rating.category}, score ${rating.score.toFixed(2)}, ${rating.sources} source list${rating.sources === 1 ? "" : "s"})`,
		};
	} else if (AGGREGATOR_HOSTS.some((marker) => host.includes(marker))) {
		result = { tier: "aggregator", factor: 0.75, detail: "content aggregator or document mirror, not the source of record" };
	} else if (INSTITUTION_HOST.test(host)) {
		result = { tier: "institution", factor: 1.05, detail: "government or academic host" };
	} else if (JOURNAL_HOST.test(host)) {
		result = { tier: "journal", factor: 1.05, detail: "journal, DOI or primary-publication host" };
	} else if (rating) {
		result = { tier: "neutral", factor: 1, detail: `CRED-1 rates this outlet ${rating.level} (score ${rating.score.toFixed(2)})` };
	} else {
		result = { tier: "neutral", factor: 1, detail: "no independent rating; treated as neutral" };
	}

	cache.set(host, result);
	return result;
}
