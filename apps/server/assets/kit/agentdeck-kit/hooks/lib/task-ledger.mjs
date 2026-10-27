// Task ledger: every task proposed and accepted — or given — is a line in TASKS.md, and every finished
// item is marked `[x]` there in the same pass. A rule alone was ignored: proposed items were forgotten and
// finished ones never marked, so the user lost track of what was chosen. Two checks hold it, both reading
// what really ran (the transcript, or the kit's session log), never the model's word.
//
// Stop (`taskLedgerAtStop`): the turn since the user last spoke is blocked once when
//   (a) it ACCEPTED tasks — the previous answer listed ≥2 items and the user took them ("yes", "do 1 and
//       3", "take them all"), the user dictated a numbered list, or a multiSelect question was answered —
//       work started and no ledger write followed; or
//   (b) it is a WORK turn — an agent spawned or handed back, a commit, or ≥3 project files edited — and
//       its last finishing event (a hand-back, a commit, a project edit) came after the last ledger write.
//   Pure Q&A and small fixes are never judged. Bound: once per state — a `task-ledger:` Stop feedback
//   after the last finishing event lets the turn through (the model had its chance; nothing finished
//   since). That is also why `stop_hook_active` is not honoured: another gate's block must not hide
//   this one. When no Stop feedback is visible at all the flag is honoured, so a CLI build that stops
//   recording feedback cannot loop. Hand-installed CLIs (no readable transcript): judged from the kit's
//   session log — edits and commits only, acceptance only from a numbered list the user typed, bounded
//   by `stop_hook_active`.
// PreToolUse (default export, Write/Edit): a SUBAGENT editing a TASKS.md is denied once — one writer per
//   ledger, the session that owns it; parallel agents marking their items corrupt it. The subagent
//   reports each subtask's status in its return, the parent marks. Repeat = escape.
// Ledger: `<project>/TASKS.md` when the main checkout keeps one; else `.agent/TASKS.md` (local, out of
// git) — always in a linked worktree or a panel group copy, where the root file is tracked and would
// ride into the MR. Rule text: skills/situational-rules/references/task-ledger.md.
// AGENTDECK_KIT_TASK_LEDGER=0 (or CLAUDE_TASK_LEDGER=0) turns both off; the user switches the Stop half
// off for one turn in words ("no ledger", "без TASKS").
// Contract: stop (input) → { decision:'block', reason } | null; pre (input) → deny | null.
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readTail,
  sinceLastCompact,
  toolEvents,
  lastUserSpeech,
  currentUserPrompt,
  inSubagent,
  ownTranscript,
  wasBlocked,
  wasJustRefused,
  deny,
} from './transcript.mjs';
import { cliOf, isHandInstalled, sessionEvents } from './kit-paths.mjs';
import { turnFromLog } from './verify-at-stop.mjs';

const LEDGER = /(?:^|[\\/])TASKS\.md$/i;
const EDIT_TOOL = /^(?:Write|Edit|MultiEdit|NotebookEdit)$/;
const SPAWN_TOOL = /^(?:Agent|Task)$/;
const SHELL_TOOL = /^(?:Bash|PowerShell)$/;
// Not task work: agent notes, scratch, temp, deps, build output, memory and transcripts.
const SKIP_PATH =
  /[\\/](?:\.agent|\.git|node_modules|dist|build|coverage|scratchpad|Temp|tmp|cache)[\\/]|[\\/]\.claude[\\/]projects[\\/]/i;
const NOTES = /(?:^|[\\/])(?:TASKS|PROGRESS)\.md$|TASKS-done-/i;
const COMMIT = /\bgit\b(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/;
const SHELL_WRITE =
  /(?<![\d&])>>?(?!&)|\btee\b|\bsed\s+-[a-z]*i|\bperl\s+-[a-z]*i|Set-Content|Add-Content|Out-File|writeFileSync|appendFileSync|\b(?:mv|cp)\s/i;
const ASYNC_LAUNCH = /^\s*Async agent launched/i;
// Only an AGENT's notification is a hand-back; a background shell command notifies in the same shape.
const AGENT_DONE = /<status>(?:completed|failed)<\/status>\s*<summary>Agent\s+"([^"]*)"/;
// A review lane or verifier finishes no ledger item by itself: the parent acts on its findings. Replay of
// 30 sessions: 390 of ~1500 hand-backs were `deep-review …` / `review: …` lanes.
const REVIEW_AGENT = /^\s*(?:deep-review\b|review\s*:|review\b)/i;
const OWN_FEEDBACK = /^\s*Stop hook feedback:[\s\S]*\btask-ledger:/;
const ANY_FEEDBACK = /^\s*Stop hook feedback:/;
const WORK_FILES = 3;
const INJECTED = /^\s*(?:<[a-z][\w-]*[\s>]|Base directory for this skill:)/i;

const LIST_ITEM = /^[ \t]{0,6}(?:\d{1,2}[.)]|[-*•]|[A-ZА-Я]\d{1,2}[.):]?)[ \t]+\S/gm;
const NUMBERED = /^[ \t]{0,6}\d{1,2}[.)][ \t]+\S/gm;
// The user taking proposed items. Cyrillic needs explicit edges: \b and \w are ASCII-only in JS.
// A bare "ok, …" opens many dictated messages that are comments or questions, so the leading yes counts
// only in a short reply; an action verb counts in any reply.
const SHORT_YES =
  /^\s*(?:да|ага|угу|ок(?:ей)?|ok(?:ay)?|yes|yep|go|sure|давай(?:те)?|го|поехали|погнали|принято|согласен|согласна|годится|подходит|отлично|супер|хорошо)(?![а-яёa-z])/i;
const SHORT = 80;
const ACCEPT = new RegExp(
  [
    '(?<![а-яё])(?:делай|делаем|сделай|реализуй|внедряй|бери|берём|берем|возьми|запускай|приступай|выполняй|займись|начинай|в\\s+работу)(?![а-яё])',
    '(?<![а-яё])(?:пункт|задач|вариант)[а-яё]*\\s*(?:№\\s*)?\\d',
    '^\\s*\\d{1,2}(?:\\s*(?:,|и|and|\\+|-|–)\\s*\\d{1,2})+\\s*\\.?\\s*$',
    '(?<![а-яё])(?:все|всё)\\s+(?:пункты|задачи|варианты|предложения)',
    '\\b(?:do it|go ahead|all of them|take them|items?\\s+\\d)\\b',
  ].join('|'),
  'i',
);
const OPT_OUT =
  /TASKS(?:\.md)?\W{0,3}(?:не\s+(?:трог|меня|прав|пиш))|не\s+(?:трогай|меняй|правь|пиши\s+в)\s+TASKS|без\s+TASKS|(?:не|без)\s+(?:вед\w+\s+)?(?:уч[её]т\w*|реестр\w*|запис\w*)\s+задач|\bno\s+(?:task\s+)?ledger\b|\bskip\s+the\s+(?:task\s+)?ledger\b|\b(?:don'?t|do\s+not)\s+touch\s+TASKS/i;

const off = () =>
  process.env.AGENTDECK_KIT_TASK_LEDGER === '0' || process.env.CLAUDE_TASK_LEDGER === '0';

/** Plain text of a record's message body (string or text parts). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

const count = (re, text) => (String(text).match(re) ?? []).length;

/** The answer the user was replying to: assistant text right before `index`, back to the previous tool result or speech. */
export function answerBefore(records, index) {
  const parts = [];
  for (let i = index - 1; i >= 0; i--) {
    const r = records[i];
    if (r?.type === 'assistant') {
      const t = textOf(r.message?.content);
      if (t) parts.unshift(t);
      continue;
    }
    if (r?.type === 'user') break;
  }
  return parts.join('\n');
}

/** Did the user's words take tasks into work: an accepted list, or a numbered list of their own. */
export function accepted(speech, answer) {
  const said = String(speech ?? '').trim();
  if (count(NUMBERED, said) >= 2) return true;
  if (count(LIST_ITEM, answer) < 2) return false;
  return ACCEPT.test(said) || (said.length <= SHORT && SHORT_YES.test(said));
}

const reviewLane = (description) => REVIEW_AGENT.test(String(description ?? ''));

const norm = (p, base) => {
  const s = resolve(base || '.', String(p)).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

/** A linked git worktree (or submodule) keeps `.git` as a file; its tracked TASKS.md belongs to the branch. */
function linkedWorktree(dir) {
  try {
    return statSync(join(dir, '.git')).isFile();
  } catch {
    return false;
  }
}

const panelGroup = () =>
  Boolean(String(process.env.AGENTDECK_GROUP_STAGE ?? '').trim()) ||
  process.env.AGENTDECK_SPLIT_CHILD === '1';

/** Where this project's ledger lives; `{path, rootBanned}`. */
export function ledgerOf(dir) {
  const root = join(dir, 'TASKS.md');
  const rootBanned = panelGroup() || linkedWorktree(dir);
  if (!rootBanned && existsSync(root)) return { path: root, rootBanned };
  return { path: join(dir, '.agent', 'TASKS.md'), rootBanned };
}

/** Is `p` a ledger write that counts here (the tracked root file does not, in a copy). */
function countsAsLedger(p, dir, rootBanned) {
  if (!LEDGER.test(p)) return false;
  return !(rootBanned && dir && norm(p, dir) === norm(join(dir, 'TASKS.md')));
}

/**
 * One walk over the turn: positions of ledger writes, finishing events and own Stop feedback.
 * Positions are record indexes inside `turn`; a call counts at its result, and only if it ran.
 */
export function scanTurn(turn, dir) {
  const uses = new Map();
  const files = new Set();
  // started = work began (a project edit, a spawn, a commit): accepted tasks are owed a line only once in work.
  const out = {
    writes: [],
    finishes: [],
    started: [],
    own: [],
    feedback: 0,
    spawns: 0,
    handbacks: 0,
    commits: 0,
    picks: [],
    files,
  };
  const rootBanned = dir ? ledgerOf(dir).rootBanned : false;
  const handback = (text, i) => {
    const m = AGENT_DONE.exec(String(text ?? ''));
    if (!m || reviewLane(m[1])) return false;
    out.handbacks++;
    out.finishes.push(i);
    return true;
  };
  turn.forEach((r, i) => {
    const content = r?.message?.content;
    if (r?.type === 'attachment') {
      const a = r.attachment;
      if (a?.type === 'queued_command') handback(a.prompt, i);
      return;
    }
    if (r?.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c?.type === 'tool_use') uses.set(c.id, c);
      return;
    }
    if (r?.type !== 'user') return;
    if (typeof content === 'string' || !content?.some?.((c) => c?.type === 'tool_result')) {
      const t = textOf(content);
      if (ANY_FEEDBACK.test(t)) {
        out.feedback++;
        if (OWN_FEEDBACK.test(t)) out.own.push(i);
      } else handback(t, i);
      return;
    }
    for (const c of content) {
      if (c?.type !== 'tool_result') continue;
      const use = uses.get(c.tool_use_id);
      if (!use) continue;
      const body =
        typeof c.content === 'string'
          ? c.content
          : Array.isArray(c.content)
            ? c.content.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n')
            : '';
      if (wasBlocked(body)) continue;
      const name = String(use.name ?? '');
      const input = use.input ?? {};
      if (EDIT_TOOL.test(name)) {
        if (c.is_error) continue;
        const p = String(input.file_path ?? input.notebook_path ?? '');
        if (LEDGER.test(p)) {
          if (countsAsLedger(p, dir, rootBanned)) out.writes.push(i);
        } else if (p && !SKIP_PATH.test(p) && !NOTES.test(p)) {
          files.add(norm(p, dir));
          out.finishes.push(i);
          out.started.push(i);
        }
      } else if (SPAWN_TOOL.test(name)) {
        out.spawns++;
        // A review lane starts no ledger item ("/deep-review" turns read as accepted work).
        if (reviewLane(input.description)) continue;
        out.started.push(i);
        if (!ASYNC_LAUNCH.test(body) && !c.is_error) {
          out.handbacks++;
          out.finishes.push(i);
        }
      } else if (SHELL_TOOL.test(name)) {
        const cmd = String(input.command ?? '');
        // Lenient on purpose: a shell line naming TASKS.md beside a write operator counts as a ledger write.
        if (!c.is_error && /TASKS\.md/i.test(cmd) && SHELL_WRITE.test(cmd)) out.writes.push(i);
        if (!c.is_error && COMMIT.test(cmd)) {
          out.commits++;
          out.finishes.push(i);
          out.started.push(i);
        }
      } else if (
        name === 'AskUserQuestion' &&
        input.questions?.some?.((q) => q?.multiSelect) &&
        !c.is_error
      ) {
        out.picks.push(i);
      }
    }
  });
  return out;
}

const last = (list) => (list.length ? list[list.length - 1] : -1);

/** The verdict over one transcript window; null = the ledger is current or not owed. */
export function ledgerOwed(records, dir) {
  const { index, text } = lastUserSpeech(records);
  const turn = records.slice(index + 1); // index -1 → the whole tail is the turn
  const s = scanTurn(turn, dir);
  // A skill body (isMeta) or a panel injection (`<agentdeck-…>`) is not the user taking tasks, even when
  // it carries a numbered list (replay: 9 of 11 hits in one project were a review skill's body).
  const typed = index >= 0 && !records[index]?.isMeta && !INJECTED.test(text);
  const took = typed && accepted(text, answerBefore(records, index));
  const pickAt = last(s.picks);
  const lastWrite = last(s.writes);
  const lastFinish = last(s.finishes);
  const work = s.spawns > 0 || s.handbacks > 0 || s.commits > 0 || s.files.size >= WORK_FILES;
  // Taken INTO WORK: a talk-only reply to a list owes nothing yet; the turn that starts the work does.
  const inWork = s.started.length > 0;
  const workAfterPick = pickAt >= 0 && last(s.started) > pickAt;
  const unrecorded = (took && inWork && lastWrite < 0) || (workAfterPick && lastWrite < pickAt);
  const stale = work && lastFinish > lastWrite;
  if (!unrecorded && !stale) return null;
  // Already told for this state: the model answered the block and nothing finished since.
  if (last(s.own) > Math.max(lastFinish, pickAt)) return null;
  return { unrecorded, stale, took, scan: s, lastWrite, speech: text };
}

/**
 * The same verdict over a turn rebuilt from the kit's session log (`turnFromLog`): calls as they were let
 * through — edits by file, shell lines by command; no hand-backs and no previous answer, so acceptance is
 * a numbered list the user typed.
 */
export function ledgerOwedFromLog(turn, dir) {
  if (!turn) return null;
  const rootBanned = dir ? ledgerOf(dir).rootBanned : false;
  const files = new Set();
  const s = { writes: [], finishes: [], started: [], spawns: 0, handbacks: 0, commits: 0, files };
  turn.calls.forEach((e, i) => {
    const name = String(e.name ?? '');
    const p = String(e.input?.file_path ?? '');
    const cmd = String(e.input?.command ?? '');
    if (EDIT_TOOL.test(name)) {
      if (LEDGER.test(p)) {
        if (countsAsLedger(p, dir, rootBanned)) s.writes.push(i);
      } else if (p && !SKIP_PATH.test(p) && !NOTES.test(p)) {
        files.add(norm(p, dir));
        s.finishes.push(i);
        s.started.push(i);
      }
    } else if (SHELL_TOOL.test(name)) {
      if (/TASKS\.md/i.test(cmd) && SHELL_WRITE.test(cmd)) s.writes.push(i);
      if (COMMIT.test(cmd)) {
        s.commits++;
        s.finishes.push(i);
        s.started.push(i);
      }
    }
  });
  const lastWrite = last(s.writes);
  const took = count(NUMBERED, turn.prompt) >= 2;
  const unrecorded = took && s.started.length > 0 && lastWrite < 0;
  const stale = (s.commits > 0 || files.size >= WORK_FILES) && last(s.finishes) > lastWrite;
  if (!unrecorded && !stale) return null;
  return { unrecorded, stale, took, scan: s, lastWrite, speech: turn.prompt };
}

function inTemp(dir) {
  const d = String(dir ?? '').replace(/\\/g, '/');
  const t = tmpdir().replace(/\\/g, '/');
  return (
    (t && d.toLowerCase().startsWith(t.toLowerCase())) ||
    /\/AppData\/Local\/Temp(?:\/|$)|^\/tmp(?:\/|$)|\/scratchpad(?:\/|$)/i.test(d)
  );
}

function reasonOf(v, ledger, dir) {
  const rel = ledger.path.startsWith(dir)
    ? ledger.path.slice(dir.length).replace(/^[\\/]/, '')
    : ledger.path;
  const s = v.scan;
  const done = [
    s.handbacks ? `${s.handbacks} agent hand-back${s.handbacks > 1 ? 's' : ''}` : '',
    s.commits ? `${s.commits} commit${s.commits > 1 ? 's' : ''}` : '',
    s.files.size ? `${s.files.size} edited file${s.files.size > 1 ? 's' : ''}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const cause = v.unrecorded
    ? `the user took proposed tasks into work this turn${v.speech ? ` («${String(v.speech).trim().slice(0, 50)}»)` : ''} and no ledger write followed`
    : `this turn finished work (${done || 'spawned agents'}) after the last ledger write${v.lastWrite < 0 ? ' — none this turn' : ''}`;
  return (
    `task-ledger: ${cause}. Ledger = ${rel} (the list; details → .agent/PROGRESS.md)` +
    `${ledger.rootBanned ? ' — never the tracked root TASKS.md in this copy' : ''}. Now, with Edit (Grep the line, no whole read): ` +
    'every task proposed and accepted, or given, is a line — `- [ ]` open, `- [x]` done, subtasks indented under their task; ' +
    'mark `[x]` what is finished AND verified, partial stays `[ ]` with a short status; a task whose items are all `[x]` moves whole ' +
    "to .agent/archive/TASKS-done-<YYYY-MM-DD>.md. Text in the user's language. Nothing accepted or finished → end again with the " +
    'same summary; never invent entries.'
  );
}

/** Stop module. Contract: (input) → { decision:'block', reason } | null. */
export function taskLedgerAtStop(input) {
  if (off()) return null;
  if (inSubagent(input)) return null;
  const dir = String(process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd());
  if (!dir || inTemp(dir)) return null;
  if (isHandInstalled(cliOf(input))) {
    // No feedback record to bound by: the re-entry flag is the bound here.
    if (input?.stop_hook_active) return null;
    const v = ledgerOwedFromLog(turnFromLog(sessionEvents(input)), dir);
    if (!v || OPT_OUT.test(String(v.speech ?? ''))) return null;
    return { decision: 'block', reason: reasonOf(v, ledgerOf(dir), dir) };
  }
  let records;
  try {
    records = sinceLastCompact(readTail(String(input?.transcript_path ?? '')));
  } catch {
    return null;
  }
  if (!records?.length) return null;
  const v = ledgerOwed(records, dir);
  if (!v) return null;
  // No Stop feedback visible at all → the once-per-state bound cannot be read; the flag bounds it instead.
  if (input?.stop_hook_active && v.scan.feedback === 0) return null;
  let prompt = '';
  try {
    prompt = String(currentUserPrompt(input, records) ?? '');
  } catch {
    /* no prompt store → no opt-out */
  }
  if (OPT_OUT.test(prompt)) return null;
  return { decision: 'block', reason: reasonOf(v, ledgerOf(dir), dir) };
}

/** PreToolUse(Write/Edit): a subagent never writes a TASKS.md — the parent session owns the ledger. */
export default function taskLedgerWriter(input) {
  const tool = String(input?.tool_name ?? '');
  if (!EDIT_TOOL.test(tool) || off()) return null;
  const ti = input?.tool_input ?? {};
  if (!LEDGER.test(String(ti.file_path ?? ti.notebook_path ?? ''))) return null;
  if (!inSubagent(input)) return null;
  const key = JSON.stringify(ti);
  const events = toolEvents(readTail(ownTranscript(input)));
  if (wasJustRefused(events, tool, (other) => JSON.stringify(other ?? {}) === key)) return null;
  return deny(
    'task-ledger: TASKS.md belongs to the parent session — one writer, parallel agents marking their items corrupt it. ' +
      "Put each assigned subtask's status in your return instead (done + proof / not done + why); the parent marks it. " +
      'Your prompt explicitly assigns you this file → repeat this exact call.',
  );
}
