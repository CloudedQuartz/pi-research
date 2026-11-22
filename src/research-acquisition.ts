import type { LookupOptions, LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import ipaddr from 'ipaddr.js';
import { setTimeout as wait } from 'node:timers/promises';

// Adapted from the old project's origin/riya (3cdb94b), src/acquisition.ts.
interface PageSpan { page: number; start: number; end: number; }
interface Snapshot {
  finalUrl: string;
  canonicalUrl: string;
  fetchedAt: string;
  title: string;
  text: string;
  pages?: PageSpan[];
  publishedAt?: string;
  modifiedAt?: string;
}

const moduleRequire = createRequire(import.meta.url);

/**
 * Policy-controlled source acquisition.
 *
 * Owns the network boundary: public-unicast-only DNS validation whose result is
 * pinned on the actual socket (hostname preserved for TLS SNI and the Host
 * header), one shared per-hostname delay scheduler across protocols and ports,
 * manual bounded
 * redirects with per-hop revalidation, byte/time bounds, MIME routing to
 * Readability/LinkeDOM, unpdf or plain text, and terminable extraction workers.
 */

export type AcquisitionErrorCode =
  | 'invalid-url'
  | 'policy'
  | 'dns'
  | 'redirect'
  | 'timeout'
  | 'network'
  | 'http-status'
  | 'too-large'
  | 'compressed'
  | 'unsupported-media'
  | 'extraction'
  | 'extraction-timeout';

export class AcquisitionError extends Error {
  constructor(readonly code: AcquisitionErrorCode, message: string, readonly url?: string, readonly status?: number) {
    super(message);
    this.name = 'AcquisitionError';
  }
}

export interface ResolvedAddress { address: string; family: 4 | 6; }
/** Test seam: returns the DNS records for a hostname; every record is still policy-validated. */
export type AcquisitionResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
}
export interface TransportResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
/** Test seam: performs one HTTP exchange to the already-validated pinned address. */
export type AcquisitionTransport = (request: TransportRequest) => Promise<TransportResponse>;

export interface AcquisitionOptions {
  delayMs?: number;
  timeoutMs?: number;
  dnsTimeoutMs?: number;
  maxBytes?: number;
  extractionTimeoutMs?: number;
  userAgent?: string;
  resolver?: AcquisitionResolver;
  transport?: AcquisitionTransport;
}

export interface Acquisition {
  acquire(url: string, signal: AbortSignal): Promise<Snapshot>;
}

const MIN_HOST_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_DNS_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = 'PiResearchBot/0.1 (academic course research assistant)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const normalizeText = (value: string): string => value.replace(/\r\n?/g, '\n').trim();

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));
}

interface ExtractionPackages { linkedom: string; readability: string; unpdf: string; }
interface Services {
  lastRequest: Map<string, number>;
  resolver: AcquisitionResolver;
  transport: AcquisitionTransport;
  packages: ExtractionPackages;
  userAgent: string;
  minDelayMs: number;
  timeoutMs: number;
  dnsTimeoutMs: number;
  maxBytes: number;
  extractionTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Candidate URL Normalization & Filtering
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'ref', 'amp_js_v', 'amp']);

const SKIP_DOMAINS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
  'vimeo.com', 'tiktok.com', 'www.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'twitter.com', 'x.com', 'facebook.com', 'www.facebook.com',
  'spotify.com', 'open.spotify.com',
]);

const SKIP_PATH_PATTERNS = [
  /\/login(\/|\?|$)/i,
  /\/signin(\/|\?|$)/i,
  /\/signup(\/|\?|$)/i,
  /\/auth(\/|\?|$)/i,
  /\/cart(\/|\?|$)/i,
  /\/checkout(\/|\?|$)/i,
  /\.(png|jpe?g|gif|svg|webp|ico|mp4|webm|mp3|wav|zip|tar|gz|7z|rar|exe|dmg|iso|bin)$/i,
];

/**
 * Normalizes a URL for deduplication and canonical matching:
 * - strips hash fragments
 * - lowercases scheme and host
 * - strips default ports (:80 for http, :443 for https)
 * - drops tracking query parameters (utm_*, fbclid, gclid, etc.)
 * - normalizes AMP paths and trailing slashes
 */
export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return rawUrl.trim();
  }
  parsed.hash = '';
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }

  // Filter tracking parameters
  const keys = [...parsed.searchParams.keys()];
  for (const key of keys) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.startsWith('utm_') || TRACKING_PARAMS.has(lowerKey)) {
      parsed.searchParams.delete(key);
    }
  }

  // Resolve AMP paths and trailing slash
  let pathname = parsed.pathname;
  pathname = pathname.replace(/^\/amp(\/|$)/i, '/').replace(/\/amp\/?$/i, '');
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  parsed.pathname = pathname;

  return parsed.href;
}

/**
 * Pre-fetch route filter for research candidates:
 * Skips video/audio streaming, social feed walls, login paths, and binary media assets.
 */
export function shouldSkipCandidateUrl(rawUrl: string): { skip: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { skip: true, reason: 'malformed URL' };
  }
  const host = parsed.hostname.toLowerCase();
  if (SKIP_DOMAINS.has(host) || [...SKIP_DOMAINS].some(d => host.endsWith(`.${d}`))) {
    return { skip: true, reason: `non-article domain: ${host}` };
  }
  for (const pattern of SKIP_PATH_PATTERNS) {
    if (pattern.test(parsed.pathname)) {
      return { skip: true, reason: `non-article route: ${parsed.pathname}` };
    }
  }
  return { skip: false };
}

const CAPTCHA_SIGNATURES = [
  'cf-challenge-running',
  'challenge-platform',
  'cf-browser-verification',
  'captcha-delivery.com',
  'px-captcha',
  'distil_r_captcha',
  'Attention Required! | Cloudflare',
  '<title>Just a moment...</title>',
  'Checking your browser before accessing',
  'Enable JavaScript and cookies to continue',
];

/**
 * Detects anti-bot CAPTCHA / challenge interception screens in HTML responses.
 * Legitimate pages containing Schema.org article metadata or <article> tags are exempted.
 */
export function isBotChallenge(html: string): boolean {
  if (!html || typeof html !== 'string') return false;
  if (html.includes('schema.org') && (html.includes('Article') || html.includes('NewsArticle') || html.includes('BlogPosting') || html.includes('TechArticle'))) {
    return false;
  }
  if (html.includes('<article') || html.includes('itemprop="articleBody"')) {
    return false;
  }
  const sample = html.slice(0, 8000).toLowerCase();
  return CAPTCHA_SIGNATURES.some(sig => sample.includes(sig.toLowerCase()));
}

export interface HtmlMetadata {
  canonicalUrl?: string;
  publishedAt?: string;
  modifiedAt?: string;
  jsonLdTitle?: string;
  jsonLdBody?: string;
}

/**
 * Extracts canonical URL, source-claimed publication/modified timestamps, and JSON-LD content.
 */
export function parseHtmlMetadata(html: string): HtmlMetadata {
  const result: HtmlMetadata = {};
  if (!html || typeof html !== 'string') return result;

  // 1. Canonical link
  const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  if (canonicalMatch && canonicalMatch[1]) {
    result.canonicalUrl = canonicalMatch[1].trim();
  }

  // 2. OpenGraph URL fallback
  if (!result.canonicalUrl) {
    const ogUrlMatch = html.match(/<meta[^>]+(?:property|name)=["']og:url["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:url["']/i);
    if (ogUrlMatch && ogUrlMatch[1]) {
      result.canonicalUrl = ogUrlMatch[1].trim();
    }
  }

  // 3. Published date from meta tags
  const pubMetaMatch = html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|publication_date|date|og:published_time|dc\.date|sailthru\.date)["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|publication_date|date|og:published_time|dc\.date|sailthru\.date)["']/i);
  if (pubMetaMatch && pubMetaMatch[1]) {
    const val = pubMetaMatch[1].trim();
    if (!isNaN(Date.parse(val))) result.publishedAt = new Date(val).toISOString();
  }

  // 4. Modified date from meta tags
  const modMetaMatch = html.match(/<meta[^>]+(?:property|name)=["'](?:article:modified_time|og:updated_time|last-modified|dc\.date\.modified)["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:modified_time|og:updated_time|last-modified|dc\.date\.modified)["']/i);
  if (modMetaMatch && modMetaMatch[1]) {
    const val = modMetaMatch[1].trim();
    if (!isNaN(Date.parse(val))) result.modifiedAt = new Date(val).toISOString();
  }

  // 5. JSON-LD structured data extraction
  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const raw = JSON.parse(match[1] || '');
      const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw['@graph'])) ? raw['@graph'] : [raw];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const type = String(item['@type'] || '');
        const isArticle = /Article|NewsArticle|BlogPosting|TechArticle|Report|WebPage/i.test(type);
        if (!result.publishedAt && item.datePublished && !isNaN(Date.parse(String(item.datePublished)))) {
          result.publishedAt = new Date(String(item.datePublished)).toISOString();
        }
        if (!result.modifiedAt && item.dateModified && !isNaN(Date.parse(String(item.dateModified)))) {
          result.modifiedAt = new Date(String(item.dateModified)).toISOString();
        }
        if (isArticle) {
          if (!result.jsonLdTitle && (item.headline || item.name)) {
            result.jsonLdTitle = String(item.headline || item.name).trim();
          }
          if (!result.canonicalUrl && item.url && typeof item.url === 'string') {
            result.canonicalUrl = item.url.trim();
          }
          if (!result.jsonLdBody && typeof item.articleBody === 'string' && item.articleBody.trim().length >= 80) {
            result.jsonLdBody = item.articleBody.trim();
          }
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }

  return result;
}

// ---------------------------------------------------------------------------
// URL and address policy
// ---------------------------------------------------------------------------

function validateTarget(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AcquisitionError('invalid-url', `Unsupported protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new AcquisitionError('invalid-url', 'Credentials in URLs are not allowed');
  }
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (ipaddr.isValid(literal)) assertPublicUnicast(literal);
  url.hash = '';
}

function parseTarget(rawUrl: string): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch {
    throw new AcquisitionError('invalid-url', `Malformed URL: ${rawUrl.slice(0, 200)}`);
  }
  validateTarget(url);
  return url;
}

/** Public unicast only: rejects private, loopback, link-local, CGNAT, mapped and other special ranges. */
function assertPublicUnicast(address: string): ResolvedAddress {
  let parsed: ReturnType<typeof ipaddr.parse>;
  try { parsed = ipaddr.parse(address); } catch {
    throw new AcquisitionError('policy', `Invalid IP address: ${address}`);
  }
  if (parsed.kind() === 'ipv6' && (parsed as { isIPv4MappedAddress(): boolean }).isIPv4MappedAddress()) {
    throw new AcquisitionError('policy', `IPv4-mapped IPv6 address rejected: ${address}`);
  }
  const range = parsed.range();
  if (range !== 'unicast') {
    throw new AcquisitionError('policy', `Non-public address rejected (${range}): ${address}`);
  }
  return { address: parsed.toString(), family: parsed.kind() === 'ipv4' ? 4 : 6 };
}

const defaultResolver: AcquisitionResolver = async hostname => {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((record: LookupAddress) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
};

/**
 * Resolves and validates ALL records; any non-public record fails the hostname closed. Exactly one address is pinned.
 * Resolution is bounded by `signal` and `timeoutMs`: once aborted or timed out the race is settled, so a late
 * resolver completion is discarded and can never carry the exchange into the accounting hook or the transport.
 */
async function resolveAddress(url: URL, resolver: AcquisitionResolver, signal: AbortSignal, timeoutMs: number): Promise<ResolvedAddress> {
  signal.throwIfAborted();
  const literal = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (ipaddr.isValid(literal)) return assertPublicUnicast(literal);
  let records: ResolvedAddress[];
  try {
    records = await new Promise<ResolvedAddress[]>((resolveRace, rejectRace) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const finish = (act: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
        act();
      };
      onAbort = () => finish(() => rejectRace(abortReason(signal)));
      timer = setTimeout(
        () => finish(() => rejectRace(new AcquisitionError('dns', `DNS resolution for ${url.hostname} exceeded ${timeoutMs}ms`, url.href))),
        timeoutMs,
      );
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      try {
        Promise.resolve(resolver(url.hostname)).then(
          found => finish(() => resolveRace(found)),
          error => finish(() => rejectRace(error)),
        );
      } catch (error) {
        finish(() => rejectRace(error));
      }
    });
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    if (error instanceof AcquisitionError) throw error;
    throw new AcquisitionError('dns', `DNS resolution failed for ${url.hostname}: ${message(error)}`);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new AcquisitionError('dns', `No address records for ${url.hostname}`);
  }
  const validated: ResolvedAddress[] = [];
  for (const record of records) {
    if (!record || typeof record.address !== 'string') {
      throw new AcquisitionError('policy', `Malformed resolver output for ${url.hostname}`);
    }
    validated.push(assertPublicUnicast(record.address));
  }
  const preferred = validated.find(record => record.family === 4) ?? validated[0];
  if (!preferred) throw new AcquisitionError('dns', `No usable address for ${url.hostname}`);
  return preferred;
}

function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return (_hostname: string, options: LookupOptions, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

function requestHeaders(userAgent: string): Record<string, string> {
  return {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5',
    'Accept-Encoding': 'identity',
    'Connection': 'close',
  };
}

/** One bounded GET over a fresh non-pooled socket to exactly the validated address. */
const defaultTransport: AcquisitionTransport = ({ url, address, headers, timeoutMs, maxBytes, signal }) =>
  new Promise<TransportResponse>((resolve, reject) => {
    if (signal.aborted) { reject(abortReason(signal)); return; }
    let settled = false;
    let request: ClientRequest | undefined;
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      request?.destroy();
      reject(error);
    };
    const succeed = (value: TransportResponse): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = (): void => fail(abortReason(signal));
    const timer = setTimeout(() => fail(new AcquisitionError('timeout', `Request exceeded ${timeoutMs}ms`, url.href)), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      let size = 0;
      let completed = false;
      const declared = Number(firstHeader(res.headers['content-length']));
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        fail(new AcquisitionError('too-large', `Declared content-length exceeds ${maxBytes} bytes`, url.href));
        return;
      }
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          fail(new AcquisitionError('too-large', `Response exceeded ${maxBytes} bytes`, url.href));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => { completed = true; succeed({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on('aborted', () => fail(new AcquisitionError('network', 'Response aborted before completion', url.href)));
      res.on('error', error => fail(new AcquisitionError('network', `Response failed: ${error.message}`, url.href)));
      res.on('close', () => { if (!completed) fail(new AcquisitionError('network', 'Connection closed before response completed', url.href)); });
    };
    const options: RequestOptions = {
      agent: false,
      lookup: pinnedLookup(address),
      headers,
    };
    request = url.protocol === 'https:'
      ? httpsRequest(url, options, onResponse)
      : httpRequest(url, options, onResponse);
    const sent = request;
    sent.on('error', error => fail(new AcquisitionError('network', `Request failed: ${error.message}`, url.href)));
    sent.end();
  });

// ---------------------------------------------------------------------------
// Page requests and redirects
// ---------------------------------------------------------------------------

async function exchange(target: URL, signal: AbortSignal, services: Services): Promise<{ response: TransportResponse; finalUrl: URL }> {
  let current = target;
  let redirects = 0;
  const visited = new Set<string>([current.href]);
  for (;;) {
    const address = await resolveAddress(current, services.resolver, signal, services.dnsTimeoutMs);
    const host = current.hostname;
    const spacing = services.minDelayMs;
    let remaining = (services.lastRequest.get(host) ?? 0) + spacing - Date.now();
    while (remaining > 0) {
      await wait(remaining, undefined, { signal });
      remaining = (services.lastRequest.get(host) ?? 0) + spacing - Date.now();
    }
    signal.throwIfAborted();
    services.lastRequest.set(host, Date.now());
    const response = await services.transport({
      url: current,
      address,
      headers: requestHeaders(services.userAgent),
      timeoutMs: services.timeoutMs,
      maxBytes: services.maxBytes,
      signal,
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = firstHeader(response.headers.location);
      if (!location) throw new AcquisitionError('redirect', `HTTP ${response.status} without Location`, current.href, response.status);
      redirects += 1;
      if (redirects > MAX_REDIRECTS) throw new AcquisitionError('redirect', `More than ${MAX_REDIRECTS} redirects`, current.href, response.status);
      let next: URL;
      try { next = new URL(location, current); } catch {
        throw new AcquisitionError('redirect', `Invalid redirect target ${location.slice(0, 200)}`, current.href, response.status);
      }
      validateTarget(next);
      if (visited.has(next.href)) throw new AcquisitionError('redirect', `Redirect loop at ${next.href}`, next.href);
      visited.add(next.href);
      current = next;
      continue;
    }
    return { response, finalUrl: current };
  }
}

// ---------------------------------------------------------------------------
// Media handling
// ---------------------------------------------------------------------------

function parseMediaType(header: string | undefined): { mime: string; charset?: string } {
  if (!header) return { mime: '' };
  const [type, ...params] = header.split(';');
  const mime = (type ?? '').trim().toLowerCase();
  let charset: string | undefined;
  for (const param of params) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(param);
    if (match && match[1]) charset = match[1].toLowerCase();
  }
  return charset === undefined ? { mime } : { mime, charset };
}

function sniffKind(body: Buffer): 'html' | 'pdf' | 'plain' {
  const head = body.subarray(0, 1024).toString('latin1').toLowerCase();
  if (head.replace(/^[\uFEFF\s]+/, '').startsWith('%pdf-')) return 'pdf';
  if (head.includes('<html') || head.includes('<!doctype html')) return 'html';
  return 'plain';
}

function routeMedia(headers: IncomingHttpHeaders, body: Buffer): { kind: 'html' | 'pdf' | 'plain'; mime: string; charset?: string } {
  const media = parseMediaType(firstHeader(headers['content-type']));
  if (!media.mime) {
    const kind = sniffKind(body);
    if (kind === 'plain' && body.includes(0)) throw new AcquisitionError('unsupported-media', 'Binary body without a declared media type');
    const canonical = kind === 'html' ? 'text/html' : kind === 'pdf' ? 'application/pdf' : 'text/plain';
    return media.charset === undefined ? { kind, mime: canonical } : { kind, mime: canonical, charset: media.charset };
  }
  const mime = media.mime;
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return media.charset === undefined ? { kind: 'html', mime } : { kind: 'html', mime, charset: media.charset };
  }
  if (mime === 'application/pdf') return { kind: 'pdf', mime };
  if (mime === 'text/plain') {
    if (body.includes(0)) throw new AcquisitionError('unsupported-media', 'text/plain body contains binary data');
    return media.charset === undefined ? { kind: 'plain', mime } : { kind: 'plain', mime, charset: media.charset };
  }
  throw new AcquisitionError('unsupported-media', `Unsupported media type ${mime}`);
}

function decodeText(body: Buffer, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase();
  try { return new TextDecoder(label).decode(body); }
  catch { return new TextDecoder('utf-8').decode(body); }
}

// ---------------------------------------------------------------------------
// Extraction (terminable worker: Readability and unpdf are synchronous parsers)
// ---------------------------------------------------------------------------

type WorkerJob = { kind: 'html'; html: string } | { kind: 'pdf'; bytes: Buffer };
interface WorkerResult {
  text?: string;
  title?: string;
  pages?: string[];
  canonicalUrl?: string;
  publishedAt?: string;
  modifiedAt?: string;
}

/**
 * Runs as CommonJS inside `new Worker(source, { eval: true })`; packages are
 * required through a require() anchored at this module, so no TS loader or
 * loader-specific import.meta handling is needed in the worker.
 */
const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const { createRequire } = require('node:module');
const req = createRequire(workerData.anchor);
const fail = error => parentPort.postMessage({ ok: false, error: String(error && error.message ? error.message : error) });
const run = async () => {
  const job = workerData.job;
  if (job.kind === 'html') {
    const { parseHTML } = req(workerData.packages.linkedom);
    const { Readability } = req(workerData.packages.readability);
    const htmlStr = String(job.html);
    const { document } = parseHTML(htmlStr);
    const documentTitle = String(document.title || '').trim();

    // 1. Canonical URL from <link rel="canonical"> or OpenGraph
    let canonicalUrl = '';
    const canonicalLink = document.querySelector('link[rel="canonical"]');
    if (canonicalLink) {
      canonicalUrl = String(canonicalLink.getAttribute('href') || '').trim();
    }
    if (!canonicalUrl) {
      const ogUrl = document.querySelector('meta[property="og:url"], meta[name="og:url"]');
      if (ogUrl) canonicalUrl = String(ogUrl.getAttribute('content') || '').trim();
    }

    // 2. Publication and modified timestamps from meta tags
    let publishedAt = '';
    let modifiedAt = '';
    const pubMeta = document.querySelector('meta[property="article:published_time"], meta[name="article:published_time"], meta[name="publication_date"], meta[name="date"], meta[property="og:published_time"], meta[name="dc.date"], meta[name="DC.date"], meta[name="sailthru.date"]');
    if (pubMeta) {
      const val = String(pubMeta.getAttribute('content') || '').trim();
      if (val && !isNaN(Date.parse(val))) publishedAt = new Date(val).toISOString();
    }
    const modMeta = document.querySelector('meta[property="article:modified_time"], meta[name="article:modified_time"], meta[property="og:updated_time"], meta[name="last-modified"], meta[name="dc.date.modified"]');
    if (modMeta) {
      const val = String(modMeta.getAttribute('content') || '').trim();
      if (val && !isNaN(Date.parse(val))) modifiedAt = new Date(val).toISOString();
    }

    // 3. Schema.org JSON-LD extraction
    let jsonLdBody = '';
    let jsonLdTitle = '';
    let jsonLdCanonical = '';
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        try {
          const raw = JSON.parse(script.textContent || '');
          const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw['@graph'])) ? raw['@graph'] : [raw];
          for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const type = String(item['@type'] || '');
            const isArticleType = /Article|NewsArticle|BlogPosting|TechArticle|Report|WebPage/i.test(type);
            if (!publishedAt && item.datePublished && !isNaN(Date.parse(String(item.datePublished)))) {
              publishedAt = new Date(String(item.datePublished)).toISOString();
            }
            if (!modifiedAt && item.dateModified && !isNaN(Date.parse(String(item.dateModified)))) {
              modifiedAt = new Date(String(item.dateModified)).toISOString();
            }
            if (isArticleType) {
              if (!jsonLdTitle && (item.headline || item.name)) {
                jsonLdTitle = String(item.headline || item.name).trim();
              }
              if (!jsonLdCanonical && item.url && typeof item.url === 'string') {
                jsonLdCanonical = item.url.trim();
              }
              if (!jsonLdBody && typeof item.articleBody === 'string' && item.articleBody.trim().length >= 80) {
                jsonLdBody = item.articleBody.trim();
              }
            }
          }
        } catch { /* ignore malformed JSON-LD block */ }
      }
    } catch { /* ignore query errors */ }

    if (!canonicalUrl && jsonLdCanonical) canonicalUrl = jsonLdCanonical;

    // 4. Readability extraction with JSON-LD deterministic text fallback
    let article = null;
    try { article = new Readability(document).parse(); } catch (error) { article = null; }
    let text = (article && typeof article.textContent === 'string') ? String(article.textContent) : '';
    let title = (article && String(article.title || '').trim()) || jsonLdTitle || documentTitle;

    if (!text.trim() && jsonLdBody) {
      text = jsonLdBody;
    }

    if (!text || !text.trim()) {
      return fail('Readability found no extractable article content');
    }

    parentPort.postMessage({
      ok: true,
      text,
      title: title || documentTitle,
      canonicalUrl: canonicalUrl || undefined,
      publishedAt: publishedAt || undefined,
      modifiedAt: modifiedAt || undefined,
    });
    return;
  }
  if (job.kind === 'pdf') {
    const { extractText } = req(workerData.packages.unpdf);
    const result = await extractText(job.bytes, { mergePages: false });
    const pages = Array.isArray(result && result.text) ? result.text.map(page => String(page)) : [];
    if (!pages.length) return fail('PDF text extraction returned no pages');
    parentPort.postMessage({ ok: true, text: '', title: '', pages });
    return;
  }
  fail('Unknown extraction job');
};
run().catch(fail);
`;

async function runWorker(services: Services, job: WorkerJob, signal: AbortSignal): Promise<WorkerResult> {
  signal.throwIfAborted();
  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { anchor: import.meta.url, packages: services.packages, job } });
  } catch (error) {
    throw new AcquisitionError('extraction', `Unable to start extraction worker: ${message(error)}`);
  }
  try {
    return await new Promise<WorkerResult>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        action();
      };
      const onAbort = (): void => { void worker.terminate(); finish(() => reject(abortReason(signal))); };
      const timer = setTimeout(() => {
        void worker.terminate();
        finish(() => reject(new AcquisitionError('extraction-timeout', `Extraction exceeded ${services.extractionTimeoutMs}ms`)));
      }, services.extractionTimeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      worker.once('message', (raw: unknown) => finish(() => {
        const result = raw as {
          ok?: boolean;
          error?: string;
          text?: string;
          title?: string;
          pages?: string[];
          canonicalUrl?: string;
          publishedAt?: string;
          modifiedAt?: string;
        };
        if (result && result.ok) {
          resolve({
            text: result.text ?? '',
            title: result.title ?? '',
            pages: Array.isArray(result.pages) ? result.pages : undefined,
            canonicalUrl: result.canonicalUrl,
            publishedAt: result.publishedAt,
            modifiedAt: result.modifiedAt,
          });
        } else {
          reject(new AcquisitionError('extraction', (result && result.error) || 'Extraction failed'));
        }
      }));
      worker.once('error', error => finish(() => reject(new AcquisitionError('extraction', `Extraction worker failed: ${error.message}`))));
      worker.once('exit', code => finish(() => reject(new AcquisitionError('extraction', `Extraction worker exited with code ${code}`))));
      if (signal.aborted) onAbort();
    });
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

export const MIN_ARTICLE_TEXT_LENGTH = 80;

export function isThinContent(text: string): boolean {
  return !text || text.trim().length < MIN_ARTICLE_TEXT_LENGTH;
}

async function extractHtml(html: string, services: Services, signal: AbortSignal): Promise<{
  title: string;
  text: string;
  canonicalUrl?: string;
  publishedAt?: string;
  modifiedAt?: string;
}> {
  const result = await runWorker(services, { kind: 'html', html }, signal);
  const text = normalizeText(result.text ?? '');
  if (!text) throw new AcquisitionError('extraction', 'Readability produced empty text');
  if (isThinContent(text)) throw new AcquisitionError('extraction', `Readability produced thin text (${text.length} chars)`);
  return {
    title: (result.title ?? '').slice(0, 1000),
    text,
    canonicalUrl: result.canonicalUrl,
    publishedAt: result.publishedAt,
    modifiedAt: result.modifiedAt,
  };
}

async function extractPdf(body: Buffer, services: Services, signal: AbortSignal): Promise<{ text: string; pages: NonNullable<Snapshot['pages']> }> {
  const result = await runWorker(services, { kind: 'pdf', bytes: body }, signal);
  const rawPages = result.pages ?? [];
  const pages: NonNullable<Snapshot['pages']> = [];
  let text = '';
  for (let index = 0; index < rawPages.length; index += 1) {
    const pageText = normalizeText(rawPages[index] ?? '');
    // Blank/image-only pages get no span (start === end would be an invalid span);
    // the recorded page number stays the real PDF page number, so pages after a
    // blank one keep their true numbers and offsets stay absolute in `text`.
    if (!pageText) continue;
    if (text) text += '\n';
    const start = text.length;
    text += pageText;
    pages.push({ page: index + 1, start, end: text.length });
  }
  if (!text.trim()) throw new AcquisitionError('extraction', 'PDF has no extractable text (scanned or image-only document)');
  return { text, pages };
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

async function acquire(rawUrl: string, signal: AbortSignal, services: Services): Promise<Snapshot> {
  signal.throwIfAborted();
  const requested = parseTarget(rawUrl);
  const { response, finalUrl } = await exchange(requested, signal, services);
  if (response.status !== 200) {
    throw new AcquisitionError('http-status', `HTTP ${response.status} for ${finalUrl.href}`, finalUrl.href, response.status);
  }
  const encoding = firstHeader(response.headers['content-encoding']);
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    throw new AcquisitionError('compressed', `Unexpected content-encoding ${encoding}`, finalUrl.href, response.status);
  }
  if (response.body.length > services.maxBytes) {
    throw new AcquisitionError('too-large', `Response exceeded ${services.maxBytes} bytes`, finalUrl.href, response.status);
  }
  signal.throwIfAborted();
  const media = routeMedia(response.headers, response.body);
  const fetchedAt = new Date().toISOString();
  let title = '';
  let text: string;
  let pages: NonNullable<Snapshot['pages']> | undefined;
  let canonicalUrl = finalUrl.href;
  let publishedAt: string | undefined;
  let modifiedAt: string | undefined;
  if (media.kind === 'html') {
    const rawHtml = decodeText(response.body, media.charset);
    if (isBotChallenge(rawHtml)) {
      throw new AcquisitionError('policy', 'bot-challenge detected (Cloudflare/CAPTCHA challenge screen)', finalUrl.href, response.status);
    }
    const extracted = await extractHtml(rawHtml, services, signal);
    title = extracted.title;
    text = extracted.text;
    if (extracted.canonicalUrl) {
      try {
        const resolved = new URL(extracted.canonicalUrl, finalUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
          resolved.hash = '';
          canonicalUrl = resolved.href;
        }
      } catch { /* keep finalUrl.href */ }
    }
    publishedAt = extracted.publishedAt;
    modifiedAt = extracted.modifiedAt;
  } else if (media.kind === 'pdf') {
    const extracted = await extractPdf(response.body, services, signal);
    text = extracted.text;
    pages = extracted.pages;
  } else {
    text = normalizeText(decodeText(response.body, media.charset));
  }
  if (!text.trim()) throw new AcquisitionError('extraction', 'Extracted text is empty', finalUrl.href);
  signal.throwIfAborted();
  return { finalUrl: finalUrl.href, canonicalUrl, fetchedAt, title, text, pages, publishedAt, modifiedAt };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function AcquisitionService(options: AcquisitionOptions = {}): Acquisition {
  const packages: ExtractionPackages = {
    linkedom: moduleRequire.resolve('linkedom'),
    readability: moduleRequire.resolve('@mozilla/readability'),
    unpdf: moduleRequire.resolve('unpdf'),
  };
  const requestedDelay = positiveNumber(options.delayMs, MIN_HOST_DELAY_MS);
  const services: Services = {
    lastRequest: new Map(),
    resolver: options.resolver ?? defaultResolver,
    transport: options.transport ?? defaultTransport,
    packages,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    minDelayMs: Math.max(MIN_HOST_DELAY_MS, requestedDelay),
    timeoutMs: positiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    dnsTimeoutMs: positiveNumber(options.dnsTimeoutMs, DEFAULT_DNS_TIMEOUT_MS),
    maxBytes: positiveNumber(options.maxBytes, DEFAULT_MAX_BYTES),
    extractionTimeoutMs: positiveNumber(options.extractionTimeoutMs, DEFAULT_EXTRACTION_TIMEOUT_MS),
  };
  return {
    acquire: (url, signal) => acquire(url, signal, services),
  };
}
