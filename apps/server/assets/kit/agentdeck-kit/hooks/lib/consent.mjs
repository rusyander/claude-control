// Consent gate shared by the Bash-side guards (git / destructive / secret).
//
// Why it is not a permission dialog. `permissionDecision: 'ask'` is silently DROPPED in permissive
// session modes, so the three guards that relied on it were no-ops in exactly the modes where the
// user is least likely to be watching the screen. `deny` is the only verdict honoured in every
// mode — so consent is expressed as "deny unless the user's own words authorise it".
//
// Two doors, and only the USER can open either:
//   A. the message the user typed this turn names the operation ("commit it", "push", "delete dist");
//   B. we refused this same operation earlier and the user has typed something since, without
//      saying no.
// Door B is what makes the gate unbypassable inside a single assistant turn: repeating the call
// cannot help, because no user record can appear in the transcript until the turn ends. That is the
// difference from the `wasJustRefused` escape used by the context guards, where a plain repeat is
// the intended escape — here a repeat is worthless on its own.
// Door B is also what makes the gate impossible to jam shut: whatever the user types next reopens
// it, including wording door A's vocabulary misses.
//
// Two more doors close the loop the deny text itself prescribes — "say which command, wait for the
// answer". Replayed over 245 retained denials, ~20 were exactly that: the agent asked "commit?", the
// user typed "yes, go", and the gate still refused, because the answer names no op and there was no
// earlier refusal for door B to count. The user paid a second "yes", sometimes a third.
//   B′. my last message before the user's latest reply names the op and asks for a go-ahead, and the
//       reply is not a refusal. Same strength as B: a question about THIS op, then the user's turn.
//   D.  this turn an AskUserQuestion answer names the op, or answers a question naming it with a yes.
//       The answer is the user's click or typing — the same thing as a typed reply, delivered mid-turn.
//   D′. the same answer delivered as the user's NEXT message — how the panel runs cards in `-p` mode
//       (24.09.2026, findings 113/120); see `answeredCard`.
// Neither can be manufactured inside one assistant turn: B′ needs a user record after my question,
// and D needs the harness-written answer record.
//
// Ops that are irreversible on shared state (force-push, DROP/TRUNCATE, kubectl delete) set
// `reconfirm` — door A is closed for them, so even a direct request costs one explicit answer.
// B, B′ and D are all such answers; `asked` names the op for B′/D where there is no door-A intent.
// Merge never reaches this gate: git-guard refuses it outright.
//
// Fail-open on an unreadable transcript, like every other guard here: a guard that jams on a
// missing file would block real work with no way out. Without a Claude transcript (Qwen, Codex) the
// gate runs doors A and B on the kit's own session log (`kit-paths.mjs`): the prompts the user typed
// and the refusals issued, both recorded by the kit itself.
//
// The regexes below carry Russian stems on purpose: they match what the USER typed, in either
// language. They are data, not instructions.
import {
  readTail,
  sinceLastCompact,
  currentUserPrompt,
  lastUserSpeech,
  userSpeech,
  isRefusal,
  deny,
} from './transcript.mjs';
import { logSessionEvent, sessionEvents } from './kit-paths.mjs';

// A verb the user negated is not authorisation: "don't commit", "without a push" (and the Russian forms).
// JS \b is ASCII-only, so Cyrillic stems need explicit lookarounds.
const NEGATION =
  /(?<![а-яёa-z])(не|ни|нет|без|нельзя|стоп|погоди|подожди|don'?t|do not|never|without|avoid|skip|no)(?![а-яёa-z])/i;
const NEG_WINDOW = 26;
// …and negated AFTER the verb, inside the same clause: "commit later" (a live prompt of that shape
// opened door A), "push not yet". Only phrases that negate the named op: a bare negation usually
// negates the NEXT verb ("push, don't forget the MR"), and "then/later" mid-clause means "next"
// ("commit, then push"), so it counts only where the clause ends.
const NEG_AFTER =
  /^[^.!?\n,;()]{0,24}?(?<![а-яёa-z])(?:не\s+(?:надо|нужн|стоит|делай|трога|сейчас|буду|будем|пока)|нельзя|рано|потом(?=\s*(?:[.!?,;)]|$))|позже(?=\s*(?:[.!?,;)]|$))|later\b|not\s+(?:yet|now)\b)/i;
// My message asked for a go-ahead (door B′), not merely mentioned the op in a report.
const CONFIRM_CUE =
  /\?|подтверд|разреш|добро|скаж(?:и|ите)\b|напиш(?:и|ите)\b|ответ(?:ь|ьте)\b|«да»|"да"|confirm|approve|go-ahead/i;
// How much of my last message is read for B′ — the question sits at its end.
const ASK_TAIL = 1500;
// A dialog answer that defers is not a yes (door D).
const LATER =
  /(?<![а-яёa-z])(?:потом|позже|отлож|не\s+сейчас|пропуст)[а-яё]*|\b(?:later|skip|postpone|not\s+now)\b/i;
const AFFIRM =
  /^\s*(?:да|ага|угу|ок|окей|ok|okay|yes|yep|конечно|давай|делай|го|go|подтвержда|разреша)(?![а-яёa-z])/i;
// Door B′ needs a yes somewhere in the reply, not just the absence of a no: in a replay the agent asked
// for a "yes, PROJ-1000 and merge", the user wrote about moving tracker tasks, and the commit went through.
const YES_IN =
  /(?<![а-яёa-z])(?:да|ага|угу|ок|окей|конечно|давай|делай|делаю|выполня[а-яё]*|действу[а-яё]*|подтвер[а-яё]*|разреш[а-яё]*|соглас[а-яё]*|добро|вперёд|вперед|поехали|валяй|го|yes|yep|yeah|ok|okay|sure|go|lgtm|approved?)(?![а-яёa-z])/i;

// The user answered, and the answer was "no". Door B stays shut — a reply is consent only when it
// is not a refusal.
const DECLINED =
  /(?<![а-яёa-z])(нет|не\s+надо|не\s+нужно|не\s+делай|не\s+трогай|не\s+стоит|отмена|отмени|стоп|погоди|подожди|no|nope|don'?t|do not|cancel|stop|abort|wait)(?![а-яёa-z])/i;

// A sentence that states a RULE about the op is not a request for it. Live: "…and ask me before a
// delete too, when it touches real files…" opened rm for a whole turn. A false ask here costs one
// "yes" (door B′); a false open costs a deleted file.
const POLICY =
  /(?<![а-яёa-z])(?:спраш[а-яё]*|спрос(?:и|ит|ишь|ят|ите)[а-яё]*|запрещ[а-яё]*|запрет[а-яё]*)(?![а-яёa-z])|\bask\s+(?:me\s+)?(?:first|before)\b|\bforbidden\b|\bnot\s+allowed\b/i;

/** Does the prompt name this operation, in a place the user did not negate? */
export function namedByUser(prompt, intent) {
  const text = String(prompt || '');
  if (!text || !intent) return false;
  const scan = new RegExp(
    intent.source,
    intent.flags.includes('g') ? intent.flags : intent.flags + 'g',
  );
  for (const m of text.matchAll(scan)) {
    // Both windows stay inside the op's own clause: "no push, just commit" negates the push only.
    const before = text
      .slice(Math.max(0, m.index - NEG_WINDOW), m.index)
      .split(/[.!?\n,;()]/)
      .pop();
    if (NEGATION.test(before) || NEG_AFTER.test(text.slice(m.index + m[0].length))) continue;
    const start = Math.max(...['.', '!', '?', '\n'].map((c) => text.lastIndexOf(c, m.index))) + 1;
    const end = text.slice(m.index).search(/[.!?\n]/);
    if (POLICY.test(text.slice(start, end < 0 ? undefined : m.index + end))) continue;
    return true;
  }
  return false;
}

/** The reply mentions the op, but only negated: "yes, but don't push". */
function negatedIn(text, intent) {
  return (
    new RegExp(intent.source, intent.flags.replace('g', '')).test(text) &&
    !namedByUser(text, intent)
  );
}

/** Door B′: my last message before the user's latest reply asked about this op; the reply is a yes. */
function askedThenAnswered(records, asked) {
  const said = userSpeech(records);
  const reply = said.at(-1);
  if (
    !reply ||
    !YES_IN.test(reply.text) ||
    DECLINED.test(reply.text) ||
    negatedIn(reply.text, asked)
  )
    return false;
  const from = said.length > 1 ? said.at(-2).index : -1;
  for (let i = reply.index - 1; i > from; i--) {
    const r = records[i];
    if (r?.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    const text = r.message.content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (!text) continue;
    const tail = text.slice(-ASK_TAIL);
    return CONFIRM_CUE.test(tail) && namedByUser(tail, asked);
  }
  return false;
}

/** One question/answer pair approves this op: the answer names it, or says yes to a question naming it. */
function approves(question, answer, asked) {
  const a = String(answer ?? '');
  if (DECLINED.test(a) || LATER.test(a) || negatedIn(a, asked)) return false;
  return namedByUser(a, asked) || (namedByUser(String(question ?? ''), asked) && AFFIRM.test(a));
}

/** Door D: an AskUserQuestion answer given after the user's latest message approves this op. */
function answeredInDialog(records, asked) {
  const since = lastUserSpeech(records).index;
  for (let i = records.length - 1; i > since; i--) {
    const answers = records[i]?.toolUseResult?.answers;
    if (!answers || typeof answers !== 'object') continue;
    for (const [question, answer] of Object.entries(answers)) {
      if (approves(question, answer, asked)) return true;
    }
  }
  return false;
}

// The agentdeck panel words a card answer this way (its composeAnswer.ts) — the user's message, matched as data.
// The panel prefixes a picked card option with this (matched as data, both languages).
const PICKED = /^\s*(?:Пользователь выбрал|User (?:picked|chose|selected)):\s*/i;

/**
 * Door D′ — the card answer that arrives as the user's NEXT message (live split run). In `-p` mode the panel denies `AskUserQuestion` at once, shows the question as a
 * card, and sends the pick as an ordinary message: the bare option label for one question,
 * `<header or question>: <labels>` lines for several. Door D never saw it (no `toolUseResult.answers`),
 * door B′ never saw it (the question sits in a tool_use, not in my text, and "Rebase + force-with-lease
 * (Recommended)" has no "yes"). Same strength as B′: my AskUserQuestion after the user's previous
 * message, then the user's reply — nothing an assistant turn can manufacture.
 */
function answeredCard(records, asked) {
  const said = userSpeech(records);
  const reply = said.at(-1);
  if (!reply) return false;
  const text = reply.text.replace(PICKED, '').trim();
  const from = said.length > 1 ? said.at(-2).index : -1;
  for (let i = reply.index - 1; i > from; i--) {
    const content = records[i]?.type === 'assistant' ? records[i].message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== 'tool_use' || c.name !== 'AskUserQuestion') continue;
      const questions = Array.isArray(c.input?.questions) ? c.input.questions : [];
      if (questions.length === 1 && approves(questions[0]?.question, text, asked)) return true;
      if (questions.length < 2) continue;
      for (const q of questions) {
        const title = String(q?.header || q?.question || '');
        const line = text.split('\n').find((l) => title && l.startsWith(`${title}:`));
        if (line && approves(q?.question, line.slice(title.length + 1).trim(), asked)) return true;
      }
    }
  }
  return false;
}

/** Record index of our most recent refusal carrying this marker, or -1. */
function lastRefusalIndex(records, marker) {
  let idx = -1;
  for (let i = 0; i < records.length; i++) {
    const content = records[i]?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || c.type !== 'tool_result') continue;
      const body =
        typeof c.content === 'string'
          ? c.content
          : Array.isArray(c.content)
            ? c.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n')
            : '';
      // isRefusal is a PREFIX test on purpose — a Read whose content merely mentions the marker
      // (this file does) must never count as a refusal.
      if (isRefusal(body) && body.includes(marker)) idx = i;
    }
  }
  return idx;
}

/**
 * null = allowed, or a `deny` verdict.
 * `marker` must be stable per operation class, not per command line: the user answers a question
 * about committing, then the commit runs with a tweaked message — same door, no second question.
 */
export function consentGate(input, { marker, intent, asked = intent, reconfirm = false, reason }) {
  const records = sinceLastCompact(readTail(input?.transcript_path));
  if (!reconfirm && namedByUser(currentUserPrompt(input, records), intent)) return null;
  if (!records.length) return sessionLogGate(input, marker, reason);
  const refusedAt = lastRefusalIndex(records, marker);
  if (refusedAt >= 0) {
    const spoke = lastUserSpeech(records);
    if (spoke.index > refusedAt && !DECLINED.test(spoke.text)) return null;
  }
  if (
    asked &&
    (askedThenAnswered(records, asked) ||
      answeredInDialog(records, asked) ||
      answeredCard(records, asked))
  )
    return null;
  return deny(`${marker} ${reason}`);
}

/**
 * Doors A (already checked by the caller) and B on the kit's session log, for CLIs whose transcript
 * the kit cannot parse: we refused this op class earlier and the user has typed since, not a no.
 */
function sessionLogGate(input, marker, reason) {
  const events = sessionEvents(input);
  let refusedAt = -1;
  events.forEach((e, i) => {
    if (e.kind === 'refusal' && e.marker === marker) refusedAt = i;
  });
  const spoke = events.findLast((e) => e.kind === 'prompt');
  if (
    refusedAt >= 0 &&
    spoke &&
    events.indexOf(spoke) > refusedAt &&
    !DECLINED.test(String(spoke.text ?? ''))
  )
    return null;
  logSessionEvent(input, { kind: 'refusal', marker });
  return deny(`${marker} ${reason}`);
}

/** Boilerplate every reason ends with — what to actually do about the refusal. */
export const ASK_THE_USER =
  'Say in chat exactly which command you want to run and why, wait for the answer, then run it again — the gate reopens once the user has replied. Repeating the call without asking does nothing.';
