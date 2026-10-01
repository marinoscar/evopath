// =============================================================================
// AI Coach content guard lists (E7.2, #242; docs/specs/ai-coach.md §2.6)
// =============================================================================
//
// THESE LIVE IN CODE, NOT IN SETTINGS, so an administrator cannot weaken them.
// Every pattern is matched case-insensitively against text that has been
// normalised by `normaliseForGuard` (lower case, curly quotes straightened).
//
// The lists exist to REFUSE text. They are deliberately broad: a false
// positive costs one regeneration or a static fallback line; a false negative
// puts an insult on someone's lock screen.
// =============================================================================

/** A named group of patterns. `category` is reported, the matched text never is. */
export interface GuardPatternGroup {
  category: string;
  patterns: readonly RegExp[];
}

const w = (body: string): RegExp => new RegExp(`\\b(?:${body})\\b`, 'i');

// -----------------------------------------------------------------------------
// Profanity: allowed ONLY when `resolveRegister(...).profane` (Sarge L3).
// -----------------------------------------------------------------------------

export const PROFANITY_PATTERNS: readonly RegExp[] = [
  /\b\w*f+u+c+k+\w*\b/i,
  /\b\w*sh[i1]t+\w*\b/i,
  w('god ?damn\\w*|damn\\w*|dammit'),
  w('ass|asses|asshole\\w*|arse|arsehole\\w*|dumbass\\w*|jackass\\w*|badass\\w*|smartass\\w*'),
  w('piss\\w*'),
  w('hell'),
  w('crap\\w*'),
  w('bitch\\w*'),
  w('bastard\\w*'),
  w('bollocks|wank\\w*|bloody'),
  w('prick\\w*|twat\\w*|douche\\w*'),
];

// -----------------------------------------------------------------------------
// Banned in EVERY register (the "banned terms and topics" rule).
// -----------------------------------------------------------------------------

export const BANNED_GROUPS: readonly GuardPatternGroup[] = [
  {
    // Slurs. Broad by design; no coach text has a reason to contain any of them.
    category: 'slur',
    patterns: [
      w('nigg\\w*|negro\\w*|coons?|spics?|spick\\w*|chinks?|gooks?|kikes?|wetbacks?|beaners?|towelheads?|ragheads?'),
      w('fag\\w*|dykes?|trann(y|ies)|homos?|shemales?'),
      w('retard\\w*|spaz\\w*|spastic\\w*|cripples?|midgets?|mongoloid\\w*'),
      w('gypp?ed|gyps(y|ies)|paki\\w*|polacks?|dagos?|wops?|hymies?|injuns?|squaws?'),
    ],
  },
  {
    // Insults about, or any reference to, a protected trait. A coach message
    // has no reason to mention race, religion, sexuality, gender identity,
    // nationality or disability.
    category: 'protected_trait',
    patterns: [
      w('like a (little )?girl|like a woman|like an old (man|woman|lady)|man up|sissy|girly|effeminate'),
      w('gay|lesbian\\w*|queer|bisexual|transgender|trans|transsexual'),
      w('racial|racist|ethnic\\w*|religion|religious|muslims?|islam\\w*|jews?|jewish|christians?|hindus?|buddhists?|atheists?'),
      w('immigrants?|foreigners?|illegals?|third[- ]world'),
      w('disabled|disabilit\\w*|handicap\\w*|autis\\w*|wheelchair\\w*'),
    ],
  },
  {
    // Body and weight shaming, in every register.
    category: 'body_shaming',
    patterns: [
      w('fat|fatty|fatso|fatass|chubby|chunky|flabby|flab|lard\\w*|obese|obesity|overweight|pudgy|porky|blubber\\w*|plump|tubby|whale'),
      w('love handles|muffin tops?|beer bell(y|ies)|double chins?|thunder thighs|dad bod|mom bod|bingo wings'),
      w('skinny|scrawny|twig|beanpole|bony|ugly|hideous|gross|disgusting|repulsive'),
      w('(lose|losing|drop|dropping|shed|shedding|cut|cutting) (some |the |that |those |a few )?(weight|pounds|kilos|lbs|kg|inches|bell(y|ies)|gut)'),
      w('your (weight|waist\\w*|belly|gut|thighs|hips|bum|butt|body fat|bmi|figure|jiggle)'),
      w('beach body|bikini body|summer body|body fat|bmi|waistline'),
    ],
  },
  {
    category: 'sexual',
    patterns: [
      w('sex|sexy|sexual\\w*|naked|nude\\w*|porn\\w*|horny|orgasm\\w*|erect\\w*|arous\\w*|kinky|fetish\\w*'),
      w('boobs?|tits?|titties|dick\\w*|cock\\w*|puss(y|ies)|booty|hookers?|sluts?|slutty|whores?|thong'),
    ],
  },
  {
    category: 'self_harm',
    patterns: [
      w('kill (yourself|urself|myself|themselves)|kys|suicid\\w*|self[- ]harm\\w*|self[- ]injur\\w*'),
      w('(hurt|harm|cut|punish) (yourself|urself)|end it all|better off dead|want to die|wish you were dead|unalive\\w*'),
    ],
  },
  {
    // Diet restriction, food shaming and disordered-eating framing.
    category: 'diet_restriction',
    patterns: [
      w('starv\\w*|purg(e|ing)|binge\\w*|laxative\\w*|diet pills?|crash diet\\w*|water fast\\w*'),
      w('(skip|skipping|skipped) (a |your |the )?(meal|meals|breakfast|lunch|dinner|supper)'),
      w('(stop|quit) eating|don\'?t eat|no (carbs|food|sugar|dessert|snacks)|calorie deficit|cut (your |the |some )?calories'),
      w('(earn|earned|deserve|burn off|work off) (your |that |the |this )?(food|meal|dinner|lunch|breakfast|dessert|cookie|cake|pizza|calories)'),
      w('(cheat|guilt) meal|eat less|eating less'),
    ],
  },
  {
    // Extreme-exercise framing.
    category: 'extreme_exercise',
    patterns: [
      w('no pain,? no gain|train(ing)? through (the )?(pain|injur\\w*)|push(ing)? through (the )?(pain|injur\\w*)|ignore (the )?(pain|injur\\w*)'),
      w('(until|till) you (puke|vomit|throw up|pass out|collapse|drop|bleed)|puk(e|ing)|vomit\\w*'),
      w('no rest days?|never rest|rest is for the weak|train (while |when )?(sick|ill|injured)|twice a day,? every day'),
    ],
  },
  {
    // Medical claims: the coach never diagnoses, prescribes or promises a health outcome.
    category: 'medical_claim',
    patterns: [
      w('(cure|cures|cured|treat|treats|heal|heals|reverse|reverses|prevent|prevents) (your |the |any )?(diabetes|cancer|depression|anxiety|disease|illness|arthritis|blood pressure|hypertension|injur\\w*|condition)'),
      w('detox\\w*|boosts? (your )?immun\\w*|clinically proven|guaranteed results|medically proven'),
      w('(stop|skip|replace|instead of) (your |the )?(medication|meds|medicine|prescription|treatment|therapy)'),
      w('diagnos\\w*'),
    ],
  },
];

// -----------------------------------------------------------------------------
// Insult target (profane register): an insult must attach to effort, excuses
// or inaction. These say an insult is aimed at the body, health or worth.
// -----------------------------------------------------------------------------

/** Words that make a sentence an insult (beside any profanity). */
export const INSULT_WORDS: RegExp = w(
  'lazy|pathetic|weak|worthless|useless|loser|failure|slob|idiot\\w*|stupid|moron\\w*|dumb|sorry excuse|soft|embarrass\\w*|shame\\w*|joke',
);

/** Body, weight and health words: an insult in the same sentence targets the person, not the effort. */
export const INSULT_BODY_TERMS: RegExp = w(
  'body|bod|belly|gut|stomach|thighs?|arms?|legs?|chest|face|skin|neck|hips?|butt|bum|figure|physique|shape|weight|waist\\w*|size|heav(y|ier)|health\\w*|sick\\w*|ill|illness|injur\\w*|pain|knees?|shoulders?|heart|lungs?|joints?|age|old',
);

/** "You are worthless" and the like: an insult aimed at the person's worth, in any register. */
export const WORTH_INSULT_PATTERN: RegExp = w(
  "you('re| are)( such)?( a| an)? (worthless|useless|pathetic|loser|failure|disgrace|waste of space|nothing|nobody|joke)",
);

// -----------------------------------------------------------------------------
// Lock screen: `pushTitle` and `pushBody` while `lockScreenSafe` is on carry no
// profanity, no health term and no digit.
// -----------------------------------------------------------------------------

export const LOCK_SCREEN_HEALTH_TERMS: RegExp = w(
  'weight|weigh\\w*|kg|kgs|lbs?|pounds?|kilos?|bmi|body fat|calorie\\w*|blood|pressure|heart rate|pulse|glucose|cholesterol|injur\\w*|pain\\w*|sore\\w*|sick\\w*|ill|illness|medic\\w*|meds|diabet\\w*|readiness|sleep\\w*|pregnan\\w*|health\\w*|symptom\\w*|doctor|lab results?|measurements?|waist\\w*',
);

// -----------------------------------------------------------------------------
// Supportive register (safety, spec §2.14): calm and warm for every persona,
// no challenge phrasing, no streak framing, no pushy angle.
// -----------------------------------------------------------------------------

export const SUPPORTIVE_REGISTER_CHALLENGE_PATTERNS: readonly RegExp[] = [
  w('no excuses?|excuses?|prove (it|yourself|me wrong)|don\'?t (you )?dare|no days? off'),
  w('lazy|quitter|quitting|soft|weak|slacking|slacker|pathetic|disappoint\\w*'),
  w('streaks?|on the line|don\'?t (let|lose|break)'),
  w('move it|get moving|hurry|shoes on|report (to|for)|recruit|get (to|in) the (gym|bar)|be at the (gym|bar)'),
  w('push (yourself|harder|through)|harder|challenge\\w*|no pain|must|have to|no choice'),
  w('you (missed|skipped|slacked|bailed|blew)'),
];

/** Learning-loop angles (spec §2.8) a supportive register may use. Every other angle is pushy there. */
export const SUPPORTIVE_ANGLES: readonly string[] = ['identity', 'future_self'];
