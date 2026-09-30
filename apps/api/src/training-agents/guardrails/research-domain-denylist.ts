// =============================================================================
// RESEARCH_DOMAIN_DENYLIST: sources the researcher may never cite
// =============================================================================
//
// Low-quality domains for training evidence: social networks, video-sharing
// pages, question-and-answer sites and forums, marketplaces and link
// shorteners. A verified source on one of these (or a subdomain of one) is
// dropped by `verifyBrief`, exactly like an unverified URL. Deliberately
// short: the prompt already steers the model to guidelines, reviews and
// trials, and the critic grades evidence quality. Add a domain here, in this
// one file, when a real run shows it slipping through.
// =============================================================================

export const RESEARCH_DOMAIN_DENYLIST: readonly string[] = [
  // Social networks
  'facebook.com',
  'instagram.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'threads.net',
  'linkedin.com',
  'pinterest.com',
  'snapchat.com',
  // Video sharing
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
  // Questions and answers, forums
  'reddit.com',
  'quora.com',
  'answers.com',
  'stackexchange.com',
  // Marketplaces
  'amazon.com',
  'ebay.com',
  'aliexpress.com',
  'etsy.com',
  'walmart.com',
  // Link shorteners
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'buff.ly',
  'rebrand.ly',
];

/** Whether `domain` (a lower-case host) is a denylisted domain or a subdomain of one. */
export function isDenylistedDomain(domain: string, denylist: readonly string[] = RESEARCH_DOMAIN_DENYLIST): boolean {
  const host = domain.toLowerCase();

  return denylist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}
