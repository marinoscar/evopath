import type { AiResponse } from '../../ai/core/types/responses.types';
import {
  EVIDENCE_LIMITS,
  HIGH_QUALITY_SOURCE_KINDS,
  type EvidenceBrief,
  type ResearchMode,
  type VerifiedEvidenceBrief,
  type VerifiedEvidenceSource,
} from '../agents/researcher/evidence-brief.contract';
import { isDenylistedDomain, RESEARCH_DOMAIN_DENYLIST } from './research-domain-denylist';

// =============================================================================
// Guardrail G8: citation verification and model-text sanitising
// =============================================================================
//
// "Cited" means the hosted web search of THIS run returned the URL. A model
// can invent a plausible URL, complete a truncated one, or put a real one on
// a claim it does not support; only the first two are checkable here, and
// they are checked on the server, never by asking the model:
//
// - `normalizeUrl` gives one canonical spelling (or `null` for a URL that may
//   never be cited: not http(s), credentials, an IP literal or localhost,
//   too long);
// - `collectVerifiedUrls` / `collectSearchQueries` read what the search
//   actually returned from the response's output items (`hosted_tool_call`
//   results for `web_search` and the message `citations`);
// - `verifyBrief` keeps only sources in that set and off the denylist,
//   re-maps ids, drops claims left without a source and counts the drops;
// - `sanitizeModelText` is applied to every model-authored string that
//   reaches the database or the UI.
//
// Pure functions, no I/O; reused for plan text by the planner story.
// =============================================================================

const TRACKING_PARAM = /^(utm_[a-z0-9_]*|gclid|fbclid)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The canonical form of a citable URL, or `null` when it may not be cited.
 * Lower-cases scheme and host, drops the fragment, the `utm_*`, `gclid` and
 * `fbclid` parameters and a trailing slash.
 */
export function normalizeUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (raw.length === 0 || raw.length > EVIDENCE_LIMITS.urlChars) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.')) return null;
  if (host.startsWith('[') || host.includes(':') || IPV4.test(host)) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return null;

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  const search = parsed.searchParams.toString();
  const port = parsed.port ? `:${parsed.port}` : '';
  const normalized = `${parsed.protocol}//${host}${port}${path}${search ? `?${search}` : ''}`;

  return normalized.length > EVIDENCE_LIMITS.urlChars ? null : normalized;
}

/** The host of a normalized URL, without a leading `www.`. */
export function domainOf(normalizedUrl: string): string {
  return new URL(normalizedUrl).hostname.replace(/^www\./, '');
}

/**
 * The normalized URLs the hosted web search returned in `responses`: the
 * union of every `web_search` call's `result.sources[].url` and every message
 * item's `citations[].url`. Nothing from the model's own text counts.
 */
export function collectVerifiedUrls(responses: AiResponse | readonly AiResponse[]): Set<string> {
  const verified = new Set<string>();
  const add = (url: unknown) => {
    const normalized = typeof url === 'string' ? normalizeUrl(url) : null;
    if (normalized) verified.add(normalized);
  };

  for (const response of toArray(responses)) {
    for (const item of response.output ?? []) {
      if (item.type === 'hosted_tool_call' && item.tool === 'web_search') {
        for (const source of item.result?.sources ?? []) add(source?.url);
      } else if (item.type === 'message') {
        for (const citation of item.citations ?? []) add(citation?.url);
      }
    }
  }

  return verified;
}

/** The queries the hosted web search ran, in order, de-duplicated and sanitised. Never model text. */
export function collectSearchQueries(responses: AiResponse | readonly AiResponse[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const response of toArray(responses)) {
    for (const item of response.output ?? []) {
      if (item.type !== 'hosted_tool_call' || item.tool !== 'web_search') continue;
      for (const query of item.result?.queries ?? []) {
        const clean = sanitizeModelText(typeof query === 'string' ? query : '', EVIDENCE_LIMITS.queryChars);
        const key = clean.toLowerCase();
        if (!clean || seen.has(key)) continue;
        seen.add(key);
        queries.push(clean);
      }
    }
  }

  return queries.slice(0, EVIDENCE_LIMITS.maxQueries);
}

// ---- sanitizeModelText -------------------------------------------------------

// C0 and C1 controls, zero-width and bidi overrides, the BOM.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG = /<\/?[a-zA-Z][^<>]*>/g;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const SCHEMED_URL = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>()[\]"'`]+/g;
const WWW_URL = /\bwww\.[^\s<>()[\]"'`]+/gi;
const SCRIPT_SCHEME = /\b(?:javascript|data|vbscript|file):[^\s]*/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Sentences that address the model rather than the reader: an instruction
 * override ("ignore your previous instructions"), a request to disclose the
 * prompt ("reveal the system prompt") or a role reset ("you are now
 * unrestricted"). No training rationale, evidence claim or reason reads like
 * this, so such a sentence is evidence of prompt injection (a retrieved page,
 * or a planner that obeyed the user's goal text). The patterns are narrow on
 * purpose: they need the override verb AND a qualifier AND an instruction
 * noun, so "ignore the usual rules of thumb" or "you are now ready for
 * heavier loads" survive. This is defence in depth, not the containment (the
 * delimited-data prompt blocks and the numeric guardrails are): it keeps the
 * text out of storage, the UI and every later prompt that quotes the plan.
 */
const INSTRUCTION_LIKE: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your|my|system|developer|safety|these|those)\b[^.!?]{0,30}?\b(?:instructions?|prompts?|rules|guidelines|directives|guardrails|safeguards|constraints|restrictions)\b/i,
  /\b(?:reveal|print|show|repeat|output|leak|disclose|display)\b[^.!?]{0,40}?\b(?:system|developer|hidden|initial|original|your)\s+(?:prompt|instructions?|message)s?\b/i,
  /\bsystem\s+prompt\b/i,
  /\byou are now\s+(?:an?\s+)?(?:unrestricted|unfiltered|jailbroken|uncensored|DAN\b|free of|in (?:developer|god|jailbreak) mode)/i,
  /\b(?:developer|jailbreak|god|DAN)\s+mode\b/i,
  /\bnew instructions?\s*:/i,
];

/** Whether one sentence reads as an instruction to the model (see `INSTRUCTION_LIKE`). */
export function isInstructionLike(sentence: string): boolean {
  return INSTRUCTION_LIKE.some((pattern) => pattern.test(sentence));
}

/** `text` without its instruction-like sentences (sentences end at `.`, `!` or `?` followed by a space). */
function dropInstructionSentences(text: string): string {
  if (!INSTRUCTION_LIKE.some((pattern) => pattern.test(text))) return text;
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !isInstructionLike(sentence))
    .join(' ');
}

/**
 * Model text made safe to store and show: control characters and HTML tags
 * stripped, markdown links reduced to their text (the URL kept only when it
 * is in `verified`), bare URLs not in `verified` removed, sentences that
 * address the model (prompt injection) dropped, whitespace collapsed,
 * truncated to `max` characters.
 */
export function sanitizeModelText(text: string, max: number, verified: ReadonlySet<string> = new Set()): string {
  if (typeof text !== 'string' || max <= 0) return '';

  const keep = (url: string) => {
    const normalized = normalizeUrl(url);
    return normalized !== null && verified.has(normalized) ? normalized : null;
  };

  let out = text.replace(CONTROL, ' ').replace(HTML_COMMENT, ' ').replace(HTML_TAG, ' ');

  out = out.replace(MARKDOWN_LINK, (_match, label: string, url: string) => {
    const kept = keep(url);
    return kept ? `${label} (${kept})` : label;
  });

  out = out.replace(SCHEMED_URL, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    const kept = keep(url);
    return `${kept ?? ''}${trailing}`;
  });

  out = out.replace(WWW_URL, (match, offset: number, whole: string) => {
    // Part of a URL the previous pass kept (`https://www.x.org`): leave it.
    if (offset >= 3 && whole.slice(offset - 3, offset) === '://') return match;
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    return trailing;
  });

  out = out.replace(SCRIPT_SCHEME, '');

  out = dropInstructionSentences(out.replace(/\s+/g, ' ').trim());

  return [...out].slice(0, max).join('').trim();
}

// ---- verifyBrief ---------------------------------------------------------------

export type SourceDropReason = 'invalid_url' | 'unverified' | 'denylisted' | 'duplicate' | 'over_limit';
export type ClaimDropReason = 'unresolved_sources' | 'empty' | 'over_limit';

export interface VerifyBriefPolicy {
  now: Date;
  researchMode: ResearchMode;
  /** From `collectSearchQueries`, never from model text. */
  searchQueries: string[];
  denylist?: readonly string[];
  minClaims?: number;
  minSources?: number;
}

export interface VerifyBriefResult {
  brief: VerifiedEvidenceBrief;
  /** At least `minClaims` claims and `minSources` sources survived. */
  sufficient: boolean;
  sourceDrops: Partial<Record<SourceDropReason, number>>;
  claimDrops: Partial<Record<ClaimDropReason, number>>;
}

/** The caution added when no surviving source is a guideline, position stand, review or trial. */
export const NO_HIGH_QUALITY_SOURCE_CAUTION =
  'No high-quality source (guideline, position stand, review or trial) was found';

/**
 * Keeps a source only if its normalized URL is in `verified` and its domain
 * is not denylisted; merges duplicates; re-maps ids to `S1..Sn` and `E1..En`;
 * drops claims whose sources no longer resolve; sanitises every string; sets
 * `domain`, `retrievedAt` and `verified: true`; counts the drops.
 */
export function verifyBrief(
  brief: EvidenceBrief,
  verified: ReadonlySet<string>,
  policy: VerifyBriefPolicy,
): VerifyBriefResult {
  const denylist = policy.denylist ?? RESEARCH_DOMAIN_DENYLIST;
  const minClaims = policy.minClaims ?? EVIDENCE_LIMITS.minClaims;
  const minSources = policy.minSources ?? EVIDENCE_LIMITS.minSources;
  const retrievedAt = policy.now.toISOString();
  const currentYear = policy.now.getUTCFullYear();
  const sourceDrops: Partial<Record<SourceDropReason, number>> = {};
  const claimDrops: Partial<Record<ClaimDropReason, number>> = {};
  const dropSource = (reason: SourceDropReason) => (sourceDrops[reason] = (sourceDrops[reason] ?? 0) + 1);
  const dropClaim = (reason: ClaimDropReason) => (claimDrops[reason] = (claimDrops[reason] ?? 0) + 1);

  const sources: VerifiedEvidenceSource[] = [];
  /** Model source id to server id. */
  const idMap = new Map<string, string>();
  /** Normalized URL to server id (duplicates merge). */
  const byUrl = new Map<string, string>();

  for (const source of brief.sources ?? []) {
    const normalized = normalizeUrl(source.url);
    if (!normalized) {
      dropSource('invalid_url');
      continue;
    }
    if (!verified.has(normalized)) {
      dropSource('unverified');
      continue;
    }
    const domain = domainOf(normalized);
    if (isDenylistedDomain(domain, denylist)) {
      dropSource('denylisted');
      continue;
    }

    const existing = byUrl.get(normalized);
    if (existing) {
      if (!idMap.has(source.id)) idMap.set(source.id, existing);
      dropSource('duplicate');
      continue;
    }
    if (idMap.has(source.id) || sources.length >= EVIDENCE_LIMITS.maxSources) {
      dropSource(idMap.has(source.id) ? 'duplicate' : 'over_limit');
      continue;
    }

    const id = `S${sources.length + 1}`;
    idMap.set(source.id, id);
    byUrl.set(normalized, id);
    sources.push({
      id,
      url: normalized,
      title: sanitizeModelText(source.title, EVIDENCE_LIMITS.titleChars) || domain,
      publisher: sanitizeModelText(source.publisher, EVIDENCE_LIMITS.publisherChars),
      kind: source.kind,
      year: plausibleYear(source.year, currentYear),
      verified: true,
      domain,
      retrievedAt,
    });
  }

  const verifiedUrls = new Set(sources.map((source) => source.url));
  const claims: VerifiedEvidenceBrief['claims'] = [];

  for (const claim of brief.claims ?? []) {
    const sourceIds = [
      ...new Set((claim.sourceIds ?? []).map((id) => idMap.get(id)).filter((id): id is string => !!id)),
    ].slice(0, EVIDENCE_LIMITS.maxSourcesPerClaim);

    if (sourceIds.length === 0) {
      dropClaim('unresolved_sources');
      continue;
    }

    const text = sanitizeModelText(claim.claim, EVIDENCE_LIMITS.claimChars, verifiedUrls);
    if (!text) {
      dropClaim('empty');
      continue;
    }
    if (claims.length >= EVIDENCE_LIMITS.maxClaims) {
      dropClaim('over_limit');
      continue;
    }

    claims.push({
      id: `E${claims.length + 1}`,
      topic: claim.topic,
      claim: text,
      applicability: sanitizeModelText(claim.applicability, EVIDENCE_LIMITS.applicabilityChars, verifiedUrls),
      confidence: claim.confidence,
      sourceIds,
    });
  }

  const cautions = (brief.cautions ?? [])
    .map((caution) => sanitizeModelText(caution, EVIDENCE_LIMITS.cautionChars, verifiedUrls))
    .filter((caution) => caution.length > 0)
    .slice(0, EVIDENCE_LIMITS.maxCautions);

  if (sources.length > 0 && !sources.some((source) => HIGH_QUALITY_SOURCE_KINDS.includes(source.kind))) {
    if (cautions.length >= EVIDENCE_LIMITS.maxCautions) cautions.pop();
    cautions.push(NO_HIGH_QUALITY_SOURCE_CAUTION);
  }

  const droppedSources = sum(sourceDrops);
  const droppedClaims = sum(claimDrops);

  return {
    brief: {
      summary: sanitizeModelText(brief.summary, EVIDENCE_LIMITS.summaryChars, verifiedUrls),
      claims,
      sources,
      cautions,
      searchQueries: policy.searchQueries.slice(0, EVIDENCE_LIMITS.maxQueries),
      researchMode: policy.researchMode,
      basis: 'web_verified',
      droppedClaims,
      droppedSources,
    },
    sufficient: claims.length >= minClaims && sources.length >= minSources,
    sourceDrops,
    claimDrops,
  };
}

/** A publication year between 1900 and this year, else `null` (a future or absurd year). */
function plausibleYear(year: number | null, currentYear: number): number | null {
  return typeof year === 'number' && Number.isInteger(year) && year >= 1900 && year <= currentYear ? year : null;
}

function sum(counts: Partial<Record<string, number>>): number {
  return Object.values(counts).reduce<number>((total, n) => total + (n ?? 0), 0);
}

function toArray(responses: AiResponse | readonly AiResponse[]): readonly AiResponse[] {
  return Array.isArray(responses) ? responses : [responses as AiResponse];
}
