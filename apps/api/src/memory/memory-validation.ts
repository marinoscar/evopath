import {
  MEMORY_CONTENT_MAX,
  MEMORY_CONTENT_MIN,
  type MemoryCategory,
  type MemorySensitivity,
} from './memory.constants';

// =============================================================================
// Memory content validation (#325; docs/specs/ai-memory.md §2.3)
// =============================================================================
//
// PURE. Every write (the settings page, the coach's `remember` and
// `update_memory` tools, the background extraction) passes through
// `checkMemoryContent` before a row is written. A memory is read back into
// every later coach and planner prompt, so a stored string is a persistent
// prompt-injection vector (OWASP "memory poisoning", LLM01/ASI06): the rules
// below keep a memory to one short, declarative fact ABOUT THE USER.
//
//   length        3..300 characters after trimming and collapsing whitespace
//   shape         one or two sentences, no line breaks
//   instruction   text that addresses the assistant ("ignore previous",
//                 "you must", "always reply ...", "send ... to", "system
//                 prompt", "act as") or starts with an imperative verb
//   url, email    links, domains and email addresses
//   code          code fences, markup, shell or script fragments
//   credential    passwords, PINs, API keys, tokens, long secret-like strings
//   financial     card numbers (Luhn), IBANs, bank/account/SSN vocabulary
//   contact       phone numbers
//   third_party   health, contact or identity details about another person
//
// These are HEURISTICS: they reject the shapes an injected or over-shared
// memory takes, and the extraction prompt is told never to produce them. They
// are not a classifier, and they err on the side of rejecting (the user can
// always rephrase).
// =============================================================================

export type MemoryRejectionRule =
  | 'length'
  | 'shape'
  | 'instruction'
  | 'url'
  | 'email'
  | 'code'
  | 'credential'
  | 'financial'
  | 'contact'
  | 'third_party';

export type MemoryContentCheck =
  | { ok: true; content: string }
  | { ok: false; rule: MemoryRejectionRule; message: string };

const MESSAGES: Record<MemoryRejectionRule, string> = {
  length: `A memory must be ${MEMORY_CONTENT_MIN} to ${MEMORY_CONTENT_MAX} characters.`,
  shape: 'A memory is one short sentence on a single line.',
  instruction:
    'A memory is a fact about the user, not an instruction. Rephrase it as a statement, e.g. "User prefers short sessions."',
  url: 'A memory cannot contain links or web addresses.',
  email: 'A memory cannot contain email addresses.',
  code: 'A memory cannot contain code or markup.',
  credential: 'A memory cannot contain passwords, keys or other secrets.',
  financial: 'A memory cannot contain card, bank or other financial details.',
  contact: 'A memory cannot contain phone numbers.',
  third_party: "A memory cannot contain other people's personal details.",
};

/** Instruction-like text addressed to the assistant. */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\s+(all|any|every|previous|prior|earlier|the|your|these|those|above|below|system|safety)\b/i,
  /\byou\s+(must|should|will|shall|have to|need to|are required to|are now)\b/i,
  /\b(always|never)\s+(send|reply|respond|answer|say|tell|include|share|output|print|call|use|reveal|email|forward|recommend|mention|ignore|obey|follow|refuse)\b/i,
  /\bsystem\s+prompt\b/i,
  /\b(prompt|instructions?)\s+(injection|override)\b/i,
  /\b(new|hidden|secret|developer|system)\s+(instructions?|rules?|mode)\b/i,
  /\b(jailbreak|DAN mode|developer mode)\b/i,
  /\b(act|behave|respond)\s+as\b/i,
  /\b(pretend|roleplay|role-play)\s+(to be|you are|as)\b/i,
  /\b(send|email|e-mail|forward|post|upload|transfer|leak|exfiltrate|share)\b[^.]{0,40}\b(to|with)\s+(me|him|her|them|this|that|the following|[a-z0-9._-]+@)/i,
  /\b(assistant|AI|model|coach|chatbot)\s*[:,]?\s+(must|should|will|always|never|is required)\b/i,
];

/** A memory that opens with an imperative verb reads as a command, not a fact. */
const IMPERATIVE_START =
  /^(please\s+)?(always|never|do|don't|dont|ignore|disregard|forget|send|reply|respond|tell|say|act|pretend|remember|print|output|reveal|execute|click|visit|download|install|forward|email|upload|transfer|leak)\b/i;

const URL_PATTERNS: readonly RegExp[] = [
  /\b(?:https?|ftp|file|data|javascript):/i,
  /\bwww\./i,
  /\b[a-z0-9-]{2,}\.(?:com|net|org|io|ai|dev|app|co|ru|cn|xyz|info|biz|me|ly|gg|tk|top|site|online|link|sh|to)\b/i,
];

const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const CODE_PATTERNS: readonly RegExp[] = [
  /```|~~~/,
  /<\/?[a-z][^>]*>/i,
  /\$\(|`[^`]+`/,
  /\b(?:function\s*\(|=>|console\.|eval\(|exec\(|import\s+\w+\s+from|require\(|SELECT\s+.+\s+FROM|DROP\s+TABLE|rm\s+-rf|sudo\s)/i,
  /[{};]\s*[{};]/,
];

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(password|passcode|passwd|pwd|pin\s+(?:code|number)|api[\s_-]?keys?|secret[\s_-]?keys?|access[\s_-]?tokens?|auth[\s_-]?tokens?|bearer|private[\s_-]?keys?|seed\s+phrase|recovery\s+(code|phrase)|otp|2fa\s+code|login\s+details|credentials?)\b/i,
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA|AIza|ya29|eyJ)[-_A-Za-z0-9.]{8,}/,
  /[A-Za-z0-9+/_-]{32,}/,
  /\bPIN\b/,
];

const FINANCIAL_PATTERNS: readonly RegExp[] = [
  /\b(iban|swift|bic\s+code|routing\s+number|sort\s+code|account\s+number|card\s+number|credit\s+card|debit\s+card|cvv|cvc|bank\s+account|social\s+security|ssn|tax\s+id|passport\s+number)\b/i,
];

const PHONE_PATTERN = /\+?\(?\d[\d\s().-]{7,}\d/g;

const RELATION =
  '(?:wife|husband|partner|spouse|girlfriend|boyfriend|son|daughter|kid|kids|child|children|mother|mom|mum|father|dad|brother|sister|friend|boss|colleague|coworker|co-worker|neighbou?r|roommate|client|patient|trainer)';
const THIRD_PARTY_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\b${RELATION}(?:'s)?\\b[^.]{0,60}\\b(?:phone|address|email|birthday|date of birth|diagnos\\w*|disease|illness|cancer|diabetes|pregnan\\w*|depress\\w*|medication|medical|surgery|therapy|condition|salary|password|lives at)\\b`,
    'i',
  ),
  /\b(?:his|her|their)\s+(?:phone|address|email|diagnosis|medical|medication|salary|password|condition)\b/i,
];

/** Words that make a fact health-related (GDPR Art. 9 "data concerning health"). */
const HEALTH_PATTERN =
  /\b(pain|painful|injur\w*|hurt\w*|ache|aching|sore\s+(?:knee|back|shoulder|hip|neck)|tendon\w*|tendin\w*|sprain\w*|strain\w*|fractur\w*|surgery|rehab\w*|physio\w*|diagnos\w*|disease|illness|medical\s+condition|chronic|asthma|diabet\w*|hypertension|blood\s+pressure|heart\s+(?:condition|disease|problem|attack|surgery)|cardiac|arrhythmia|pregnan\w*|postpartum|menopaus\w*|menstrua\w*|medication|medicine|pill|insulin|arthritis|osteo\w*|hernia|concussion|migraine|epilep\w*|anxiety|depress\w*|eating\s+disorder|anorexi\w*|bulimi\w*|allerg\w*|intoleran\w*|celiac|coeliac|cancer|chemo\w*)\b/i;

/** Trims and collapses inner whitespace. */
export function tidyMemoryContent(raw: string): string {
  return raw.replace(/[\t\f\v\u00a0 ]+/g, ' ').trim();
}

/** The form near-duplicates are compared in: lower case, letters and digits only, single spaces. */
export function normalizeMemoryContent(content: string): string {
  return content
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasCardNumber(text: string): boolean {
  for (const match of text.match(/\b\d(?:[\s-]?\d){12,18}\b/g) ?? []) {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function hasIban(text: string): boolean {
  const compact = text.replace(/\s+/g, '').toUpperCase();
  return /[A-Z]{2}\d{2}[A-Z0-9]{11,30}/.test(compact) && /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,}/i.test(text);
}

function hasPhoneNumber(text: string): boolean {
  for (const match of text.match(PHONE_PATTERN) ?? []) {
    if (match.replace(/\D/g, '').length >= 9) return true;
  }
  return false;
}

function reject(rule: MemoryRejectionRule): MemoryContentCheck {
  return { ok: false, rule, message: MESSAGES[rule] };
}

/** Whether text addresses the assistant (the `instruction` rule's patterns). Reused by the coach's `set_display_name`. */
export function addressesAssistant(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((p) => p.test(text));
}

/** Whether text starts with an imperative verb (the `instruction` rule's other half). */
export function startsImperative(text: string): boolean {
  return IMPERATIVE_START.test(text);
}

/** Whether text contains a link or a domain (the `url` rule). */
export function containsUrl(text: string): boolean {
  return URL_PATTERNS.some((p) => p.test(text));
}

/** Validates (and tidies) one memory's content. */
export function checkMemoryContent(raw: string): MemoryContentCheck {
  if (typeof raw !== 'string') return reject('length');
  if (/[\r\n\u2028\u2029]/.test(raw.trim())) return reject('shape');
  const content = tidyMemoryContent(raw);
  if (content.length < MEMORY_CONTENT_MIN || content.length > MEMORY_CONTENT_MAX) return reject('length');
  // Control characters (zero-width and bidi included) hide text from the user who reviews the memory.
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(content)) return reject('shape');
  const sentences = content.split(/[.!?]+(?:\s+|$)/).filter((part) => part.trim().length > 0);
  if (sentences.length > 2) return reject('shape');

  if (CODE_PATTERNS.some((p) => p.test(content))) return reject('code');
  if (EMAIL_PATTERN.test(content)) return reject('email');
  if (URL_PATTERNS.some((p) => p.test(content))) return reject('url');
  if (hasCardNumber(content) || hasIban(content) || FINANCIAL_PATTERNS.some((p) => p.test(content))) return reject('financial');
  if (CREDENTIAL_PATTERNS.some((p) => p.test(content))) return reject('credential');
  if (hasPhoneNumber(content)) return reject('contact');
  if (THIRD_PARTY_PATTERNS.some((p) => p.test(content))) return reject('third_party');
  if (IMPERATIVE_START.test(content) || INSTRUCTION_PATTERNS.some((p) => p.test(content))) return reject('instruction');

  return { ok: true, content };
}

/**
 * The sensitivity a memory is stored with: what the writer said, raised to
 * `health` for an injury/constraint or for text that names a health matter.
 * Never lowered: a writer's `health` stays `health`.
 */
export function inferMemorySensitivity(
  content: string,
  category: MemoryCategory,
  declared?: MemorySensitivity | null,
): MemorySensitivity {
  if (declared === 'health') return 'health';
  if (category === 'constraint_injury') return 'health';
  return HEALTH_PATTERN.test(content) ? 'health' : 'normal';
}
