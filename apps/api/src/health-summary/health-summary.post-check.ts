import { normalizeForScreen } from '../training-agents/guardrails/safety-screen';
import { HEALTH_SUMMARY_MAX_WORDS, HEALTH_SUMMARY_WORD_SLACK, type HealthSummaryOutput } from './health-summary.prompt';

// =============================================================================
// The health summary post-check (H8, #192)
// =============================================================================
//
// PURE. Runs over the model's narrative and every consideration BEFORE a
// summary is stored. A hit on any rule rejects the answer: the job asks once
// more with a nudge naming the rule codes, then fails. The rules are what a
// pattern can see of the prompt's safety contract:
//
//   dosing       a dose (a number with mg, mcg, IU, ml, units, tablets ...),
//                or the words dose, dosage, dosing
//   medication   a medication word, a drug class or a common drug name
//   supplement   a supplement word or a common supplement name
//   diagnosis    "diagnosis"/"diagnosed", "you have <condition>", "indicates
//                <condition>", "consistent with <condition>" and the like
//                ("this is not a diagnosis" is allowed)
//   raw_value    a number with a lab or vital unit (mg/dL, mmol/L, mmHg, bpm
//                ...): raw values stay behind the summary boundary
//   length       a narrative over the word budget
//
// Returns rule codes only, never the matched text (nothing here may be
// logged with the answer).
// =============================================================================

export const POST_CHECK_RULES = ['dosing', 'medication', 'supplement', 'diagnosis', 'raw_value', 'length'] as const;
export type PostCheckRule = (typeof POST_CHECK_RULES)[number];

const CONDITIONS = [
  'anemia', 'anaemia', 'diabetes', 'prediabetes', 'pre diabetes', 'hypertension', 'hypotension', 'hypothyroidism',
  'hyperthyroidism', 'hyperlipidemia', 'dyslipidemia', 'hypercholesterolemia', 'kidney disease', 'renal failure',
  'liver disease', 'fatty liver', 'heart disease', 'coronary artery disease', 'metabolic syndrome', 'insulin resistance',
  'iron deficiency', 'deficiency', 'infection', 'cancer', 'leukemia', 'thalassemia', 'hemochromatosis', 'gout',
];

/** On the normalised text (lower case, single spaces, no punctuation). */
const WORD_RULES: ReadonlyArray<{ rule: PostCheckRule; re: RegExp }> = [
  { rule: 'dosing', re: /(?<= )(?:dose|doses|dosage|dosages|dosing|overdose)(?= )/ },
  {
    rule: 'dosing',
    re: /(?<= )\d+(?: \d+)? ?(?:mg|mcg|ug|iu|ml|milligrams?|micrograms?|units|tablets?|capsules?|pills?|drops)(?= )/,
  },
  {
    rule: 'medication',
    re: /(?<= )(?:medications?|medicines?|medicated|drugs?|prescriptions?|prescribed?|prescribing|pharmacolog\w*|statins?|metformin|insulin therapy|levothyroxine|beta blockers?|ace inhibitors?|diuretics?|antihypertensives?|aspirin|ibuprofen|nsaids?|antibiotics?|steroids?|hormone therapy|testosterone replacement|trt)(?= )/,
  },
  {
    rule: 'supplement',
    re: /(?<= )(?:supplements?|supplementation|supplementing|multivitamins?|vitamin [a-z0-9]+|iron tablets?|iron pills?|ferrous \w+|fish oil|omega 3|creatine|magnesium|zinc|biotin|folic acid|b12 shots?)(?= )/,
  },
  { rule: 'diagnosis', re: /(?<= )(?:diagnos(?:e|es|ed|is|ing|tic))(?= )/ },
  {
    rule: 'diagnosis',
    re: new RegExp(
      `(?<= )(?:you have|you ve got|you suffer from|suffering from|indicates|indicating|indicative of|consistent with|suggests|suggestive of|sign of|signs of|points to|means you have)(?: an?| early| mild| possible| likely| probable)? (?:${CONDITIONS.join('|')})(?= )`,
    ),
  },
  {
    rule: 'raw_value',
    re: /(?<= )\d+(?: \d+)? ?(?:mg dl|g dl|ng ml|pg ml|mmol l|mmol mol|umol l|u l|iu l|miu l|uiu ml|meq l|mmhg|bpm|10 3 ul|k ul|x10 9 l)(?= )/,
  },
  // A blood pressure written as a pair (150/95 becomes "150 95").
  { rule: 'raw_value', re: /(?<= )(?:blood pressure|bp)(?: [a-z]+){0,4} \d{2,3} \d{2,3}(?= )/ },
];

/** Disclaimers that name a forbidden word to deny it; removed before the rules run. */
const ALLOWED = [/(?<= )(?:this|it|that) (?:is|s) not (?:a )?(?:medical )?(?:diagnosis|advice)(?= )/g, /(?<= )not (?:a )?diagnos\w*(?= )/g];

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Rule codes the answer breaks, sorted and unique; empty when it passes. */
export function postCheckHealthSummary(output: HealthSummaryOutput): PostCheckRule[] {
  const broken = new Set<PostCheckRule>();
  const texts = [output.narrative, ...output.trainingConsiderations.map((c) => c.text)];

  for (const raw of texts) {
    let text = normalizeForScreen(raw.replace(/(\d)\.(\d)/g, '$1 $2'));
    for (const allowed of ALLOWED) text = text.replace(allowed, ' ');
    for (const { rule, re } of WORD_RULES) if (re.test(text)) broken.add(rule);
  }

  if (wordCount(output.narrative) > HEALTH_SUMMARY_MAX_WORDS + HEALTH_SUMMARY_WORD_SLACK) broken.add('length');

  return POST_CHECK_RULES.filter((rule) => broken.has(rule));
}
