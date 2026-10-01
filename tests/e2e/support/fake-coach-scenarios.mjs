// =============================================================================
// AI Coach answers for the fake AI servers (E7.13). TEST-ONLY, dependency-free.
// =============================================================================
//
// Pure functions the fake vision server (`fake-vision-server.mjs`, the
// OpenAI-compatible provider on port 4010) and the fake Responses server
// (`fake-responses-server.mjs`, the `openai` provider on port 4011, speech
// only) call. Nothing here reads the environment or the disk.
//
// Chat Completions requests are routed on `response_format.json_schema.name`:
//
//   coach_nudge          the structured nudge (`ai.coach.nudge`, also the kickoff)
//   coach_weekly_review  the weekly review prose (`ai.coach.weekly_review`)
//
// and a request that carries the coach chat tools (`get_training_signals`) is a
// chat turn: the first completion asks for ONE `get_training_signals` call, the
// next (a `tool` message is present) writes the final answer from that result.
// A chat message that does not ask about progress is answered directly.
//
// EVERY LINE IS CLEAN AND DIGIT-FREE, so it passes the content guard under any
// persona and register (no figure outside the context, no profanity, no
// challenge phrasing, nothing a lock screen refuses). The only figures are the
// chat answer's, and they are copied from the tool result, which the guard
// accepts as context. Persona flavour is not simulated: this proves the
// plumbing, not the voice.
//
// Speech (`POST /v1/audio/speech`): `fakeSpeech()` returns a valid MPEG-1 Layer III
// stream (silent frames) of more than 1 KiB, the size the coach treats as real
// audio. A mode switch makes it fail or refuse (see `SPEECH_MODES`).
// =============================================================================

export const COACH_NUDGE_SCHEMA = 'coach_nudge';
export const COACH_WEEKLY_REVIEW_SCHEMA = 'coach_weekly_review';
export const COACH_CHAT_TOOL = 'get_training_signals';

/** Selectable through `POST /__control/coach` on either server. */
export const NUDGE_MODES = ['send', 'decline'];
export const SPEECH_MODES = ['ok', 'fail', 'refuse'];

const CONTEXT_MARKER = 'COACH CONTEXT (JSON data):';

const LINES = {
  missed_twice: ['Back on track', 'Two sessions slipped by, and that is fine. Pick the next one on your plan and do just the first set.'],
  streak_at_risk: ['Your session is waiting', 'Today is a good day to keep your routine going. A short session still counts.'],
  comeback: ['Welcome back', 'Good to see you training again. Start easy and let the plan do the work.'],
  pr: ['New personal best', 'You lifted more than ever before. Write down how it felt and aim to repeat it.'],
  weekly_target_hit: ['Weekly target reached', 'You did everything planned this week. Take a proper rest and enjoy it.'],
  missed_session: ['About yesterday', 'Yesterday did not happen, and that is okay. Today is open, so pick a time and go.'],
  fresh_start: ['Fresh start', 'A new week is a clean page. Choose your first session and put it in your calendar.'],
  photo_prompt: ['Progress photo time', 'A quick photo today gives you something to compare later. Same spot, same light.'],
  win_back: ['Stepping back for now', 'I will give you some space. Whenever you want to train again, I am here.'],
  back_off: ['Stepping back for now', 'I will go quiet for a while. Open the app when you are ready and we pick up from there.'],
  kickoff:
    ['Your plan is live', 'Welcome to your new plan. Three quick questions so it sticks: when will you train, where will you train, and what is your fallback if the day goes sideways?'],
  weekly_review: ['Your week in review', 'Here is your week. Have a look at the numbers and pick one thing to carry forward.'],
  goal_at_risk: ['Your goal needs you today', 'Your activity goal is a little behind. A short walk today keeps it within reach.'],
  goal_hit: ['Goal reached', 'You reached your activity goal. You said you would, and you did. Enjoy it.'],
};

/** The JSON the coach put after the context marker of a user message, or null. */
export function parseNudgeContext(text) {
  const at = typeof text === 'string' ? text.indexOf(CONTEXT_MARKER) : -1;
  if (at === -1) return null;
  const line = text.slice(at + CONTEXT_MARKER.length).trim().split('\n')[0];
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The structured `coach_nudge` answer for a moment. `mode: 'decline'` answers `send: false`. */
export function nudgeAnswer(moment, mode = 'send') {
  const known = Object.hasOwn(LINES, moment) ? moment : 'streak_at_risk';
  if (mode === 'decline' && known !== 'kickoff') {
    return {
      send: false,
      moment: known,
      title: '',
      body: '',
      pushTitle: '',
      pushBody: '',
      audioScript: '',
      audioInstructions: '',
      reason: 'The fake coach is set to stay quiet.',
    };
  }
  const [title, body] = LINES[known];
  return {
    send: true,
    moment: known,
    title,
    body,
    pushTitle: title,
    pushBody: 'Your coach has a message for you.',
    audioScript: body,
    audioInstructions: 'Warm, calm and steady.',
    reason: 'The fake coach always has something to say.',
  };
}

/** The structured `coach_weekly_review` answer. No figures: the stats block carries every number. */
export function weeklyReviewAnswer() {
  return {
    headline: 'Your week in review',
    intro: 'Here is how your week went. The numbers below are the real ones, straight from your log.',
    wins: ['You showed up for your training.', 'You kept your plan moving.'],
    focus: 'Next week, protect the session you find hardest to fit in.',
    nextWeekPlanPrompt: 'Help me plan next week so I can fit every session in.',
  };
}

/** True when a Chat Completions body carries the coach chat tools. */
export function isCoachChat(body) {
  return Array.isArray(body?.tools) && body.tools.some((tool) => tool?.function?.name === COACH_CHAT_TOOL);
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

function toolResultText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'tool') return String(messages[i].content ?? '');
  return null;
}

/** `adherence.totals` of the signals tool result, or null. */
export function adherenceTotals(toolText) {
  try {
    const totals = JSON.parse(toolText)?.adherence?.totals;
    return totals && Number.isFinite(totals.completed) && Number.isFinite(totals.planned) ? totals : null;
  } catch {
    return null;
  }
}

/**
 * The Chat Completions message for a coach chat turn, plus its finish reason:
 * a `get_training_signals` call for a progress question, then the answer;
 * a direct answer for anything else.
 */
export function coachChatTurn(body) {
  const toolText = toolResultText(body);
  if (toolText !== null) {
    const totals = adherenceTotals(toolText);
    const text = totals
      ? `Here is where you stand: you completed ${totals.completed} of ${totals.planned} planned sessions. Keep your next session on the plan.`
      : 'Your training data is thin so far. Log a session and I can tell you more.';
    return { finish: 'stop', message: { role: 'assistant', content: text, refusal: null } };
  }
  if (/\b(how am i doing|progress|adherence|on track)\b/i.test(lastUserText(body))) {
    return {
      finish: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        refusal: null,
        tool_calls: [{ id: 'call_fake_signals', type: 'function', function: { name: COACH_CHAT_TOOL, arguments: '{}' } }],
      },
    };
  }
  return {
    finish: 'stop',
    message: { role: 'assistant', content: 'Got it. I am here whenever you want to talk through your plan.', refusal: null },
  };
}

// ---- speech --------------------------------------------------------------------

/** One MPEG-1 Layer III frame header: 128 kbit/s, 44.1 kHz, no padding, no CRC, joint stereo. */
const MP3_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
/** 144 * 128000 / 44100 = 417 bytes per frame. */
const MP3_FRAME_BYTES = 417;

/** A playable run of silent MP3 frames, `frames` of them (default 8: about 3.3 KiB, 0.2 s). */
export function fakeSpeech(frames = 8) {
  const parts = [];
  for (let i = 0; i < frames; i += 1) parts.push(MP3_HEADER, Buffer.alloc(MP3_FRAME_BYTES - MP3_HEADER.length));
  return Buffer.concat(parts);
}

/** The error body of a refused speech request (the coach reads it as a refusal). */
export const SPEECH_REFUSAL = {
  error: { message: 'The request was declined by the content policy.', type: 'invalid_request_error', code: 'content_policy_violation' },
};
