// PreToolUse(Bash|PowerShell): no sleep-polling of a background command, main session or subagent.
//
// A background command announces its end with a task notification that wakes the session by itself.
// Sleeping on it is blind waiting billed as wall time (measured: one review lane spent 16 min in five
// `sleep 120…280; tail <output>` rounds; a session slept 200 s on its own gate). Denied:
// `sleep`/`Start-Sleep` of 20 s or more whose command then reads a task output or a log. A fixed wait
// for a server to boot stays allowed — poll the condition instead (`until curl -s …; do sleep 2; done`).
// Also denied: `sleep` ≥ 60 s then a read of `.agent/tmp/` while an agent this session spawned runs.
// Subagents are covered too (measured week: 93 sleeps / 206 min in lanes): a lane is not reliably woken by
// its own background command, so its denial says the other way — run the long check in the FOREGROUND with
// a timeout and read the output once.
// A split-group run (AGENTDECK_SPLIT_CHILD, set by agentdeck) has no repeat escape at all: the panel holds the
// next stage while a background task lives and wakes the run with its result. Measured: 2.3 h of
// `for i in $(seq 1 115); do grep -q "^EXIT" .agent/tmp/gate2.log && break; sleep 5; done` across split
// trees — a log of its own background gate, which the repeat escape let through.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import {
  deny,
  inSubagent,
  ownTranscript,
  readTail,
  readTailText,
  toolEvents,
  wasJustRefused,
} from './transcript.mjs';
import { bareCommand } from './gate-at-end.mjs';

const SLEEP =
  /(?:^|&&|\|\||;|\n|\{|\bdo|\bthen)\s*(?:sleep|Start-Sleep(?:\s+-s(?:econds)?)?)\s+(\d+(?:\.\d+)?)/i;
// `.log`/`.output` as a file name, not a call: `console.log(` in a node -e probe is no log read.
const READS_OUTPUT =
  /[\\/]tasks[\\/][^\s"']+\.output|\.(?:output|log)\b(?!\s*\()|\btail\b|\bjournal\b|mustfail/i;
// A short sleep inside a loop waits as long as its rounds add up to: 16.10.2026 a group polled its gate
// with `for i in $(seq 1 115); do [ -s tasks/x.output ] && break; sleep 5; done` six times (~40 min), a
// 5 s sleep the per-sleep threshold never saw. The loop total counts only when the loop waits on a
// background command's end — its task output or a check's log; a server-ready probe stays allowed.
const LOOP = /\b(?:for|while|until)\b/;
// The check word starts the name or a part of it: `latest.log` (dev server) and `healthcheck.log` are no
// check logs, and a readiness loop over them was refused as a gate poll (review 20.10.2026).
const AWAITS_RUN =
  /[\\/]tasks[\\/][^\s"']+\.output|(?:^|[^a-z0-9])(?:gate|test|check|lint|tsc|type|build|vitest|jest|mustfail|ci)[\w.-]*\.log\b/i;
const PROBE = /\b(?:curl|wget|nc|Test-NetConnection|Invoke-WebRequest)\b/i;

/** Rounds of the loop around a sleep: `seq A B`, `seq B`, `{A..B}`, PowerShell `-lt N`; none = unbounded. */
function loopRounds(bare) {
  const seq = /\bseq\s+(\d+)(?:\s+(\d+))?/.exec(bare);
  if (seq) return seq[2] ? Number(seq[2]) - Number(seq[1]) + 1 : Number(seq[1]);
  const brace = /\{(\d+)\.\.(\d+)\}/.exec(bare);
  if (brace) return Number(brace[2]) - Number(brace[1]) + 1;
  const ps = /-l[te]\s+(\d+)/i.exec(bare);
  return ps ? Number(ps[1]) : Infinity;
}

/** Seconds the command can sleep in total; 0 when it is no wait on a background run. */
export function sleepTotal(command) {
  const bare = bareCommand(command);
  const m = SLEEP.exec(bare);
  if (!m || !READS_OUTPUT.test(command)) return 0;
  const once = Number(m[1]);
  if (!LOOP.test(bare) || !AWAITS_RUN.test(command) || PROBE.test(bare)) return once;
  return once * Math.max(1, loopRounds(bare));
}

const TASK_ID = /[\\/]tasks[\\/]([\w-]+)\.output/g;
const OWN_TASK_BYTES = 16 * 1024 * 1024;

/** The command polls a task output whose id this session's transcript shows going to the background. */
export function ownTaskPolled(command, transcriptText) {
  return [...command.matchAll(TASK_ID)].some(([, id]) => transcriptText.includes(`ID: ${id}`));
}

const LOG_NAME = /[\w.-]+\.log\b(?!\s*\()/g;

/**
 * The command polls a log a background command of THIS session writes: the log's file name stands in a
 * tool call of this transcript launched with `run_in_background` (`pnpm gate > .agent/tmp/gate2.log`).
 * One transcript record is one line, so the launch and its command share a line.
 */
export function ownBackgroundLog(command, transcriptText) {
  const names = [...new Set(command.match(LOG_NAME) ?? [])];
  if (!names.length) return false;
  return transcriptText
    .split('\n')
    .some(
      (line) => line.includes('"run_in_background":true') && names.some((n) => line.includes(n)),
    );
}

// Waiting on a spawned agent's deliverable: a review sat 9× `sleep 240…295; ls|wc .agent/tmp/…/lane-B.md`
// (16.10) while its lane ran — no task output named, so the checks above never saw it.
const AGENT_TMP =
  /\b(?:ls|wc|cat|test|stat|head|tail|grep|find)\b[^;&|\n]*\.agent[\\/]tmp[\\/]|\[\s+-[sfe]\s+[^\]]*\.agent[\\/]tmp[\\/]/;

/** Agent ids this session launched in the background and that have not notified yet. */
export function runningAgents(transcriptText) {
  const ids = [
    ...transcriptText.matchAll(/Async agent launched successfully[\s\S]{0,200}?agentId: (\w+)/g),
  ].map((m) => m[1]);
  return [...new Set(ids)].filter((id) => !transcriptText.includes(`<task-id>${id}</task-id>`));
}

// Phase G.4 (E6 gap): a split group held its turn up to 28 min on its own two review lanes —
// `D=.agent/tmp/review-…; for i in $(seq 1 170); do [ -f $D/lane-A.md ] && [ -f $D/lane-B.md ] &&
// break; sleep 10; done`. A 10 s sleep is under the 60 s branch below, the path sits in a variable,
// and a file test is neither a task output nor a check log, so nothing saw it. A presence loop (≥ 20 s
// in total) over agent files — `.agent/tmp/`, `subagents/`, `tasks/` — while an agent this session
// launched in the background still runs is refused in a split child with no repeat escape: the
// agent's completion notification wakes the run. No running agent → not judged here.
const FILE_TEST = /\[\[?\s+(?:!\s+)?-[efs]\s|\btest\s+(?:!\s+)?-[efs]\s/;
const AGENT_FILES = /\.agent[\\/]tmp[\\/]|[\\/]subagents[\\/]|[\\/]tasks[\\/]/;

/** Seconds a loop testing for a file can sleep in total; 0 when the command is no such loop. */
export function fileWaitTotal(command) {
  const bare = bareCommand(command);
  const m = SLEEP.exec(bare);
  if (!m || !LOOP.test(bare) || !FILE_TEST.test(bare) || PROBE.test(bare)) return 0;
  return Number(m[1]) * Math.max(1, loopRounds(bare));
}

const ownTaskReason = (wait) =>
  `bg-wait-guard: sleeping ${wait} on the output of a background command THIS session started is blind ` +
  'polling, and repeating the call does not lift it: the CLI wakes the session with a completion ' +
  'notification when the command ends. Do other work, or end the turn saying what is running.';

export default function bgWaitGuard(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(input.tool_input?.command ?? '');
  const slept = Number(SLEEP.exec(bareCommand(command))?.[1] ?? 0);
  if (slept >= 60 && AGENT_TMP.test(command) && !inSubagent(input)) {
    try {
      const transcript = ownTranscript(input);
      const events = toolEvents(readTail(transcript));
      const repeated = wasJustRefused(events, tool, (o) => String(o?.command ?? '') === command);
      if (!repeated && runningAgents(readTailText(transcript, OWN_TASK_BYTES)).length)
        return deny(
          `bg-wait-guard: sleeping ${slept} s then reading .agent/tmp/ while an agent this session spawned is ` +
            'running is blind polling: its completion notification (and handback) wakes you. Do other work, or ' +
            'end the turn saying what is running. Repeat this exact call if the wait is on something else.',
        );
    } catch {
      /* no transcript → nothing known of agents */
    }
  }
  if (
    process.env.AGENTDECK_SPLIT_CHILD === '1' &&
    !inSubagent(input) &&
    AGENT_FILES.test(command)
  ) {
    const fileWait = fileWaitTotal(command);
    if (fileWait >= 20) {
      try {
        if (runningAgents(readTailText(ownTranscript(input), OWN_TASK_BYTES)).length) {
          const span = Number.isFinite(fileWait)
            ? `${Math.round(fileWait)} s`
            : 'an unbounded loop';
          return deny(
            `bg-wait-guard: a ${span} sleep loop waiting for files of an agent this split-group run launched is ` +
              'blind polling, and repeating the call does not lift it. End the turn saying what is running: the ' +
              "agent's completion notification wakes this session with its result.",
          );
        }
      } catch {
        /* no transcript → nothing known of agents */
      }
    }
  }
  const total = sleepTotal(command);
  if (total < 20) return null;
  const wait = Number.isFinite(total) ? `${Math.round(total)} s` : 'an unbounded loop';
  const subagent = inSubagent(input);
  try {
    const transcript = ownTranscript(input);
    const text = subagent ? '' : readTailText(transcript, OWN_TASK_BYTES);
    // A split group's wait on its OWN background command: the panel holds the next stage while that
    // command lives and wakes the run with its result, so the refusal has no escape. A wait on anything
    // else (a file another process writes, a log no background command of this run writes) keeps the
    // repeat escape — nothing would wake the run, and the group would be judged finished.
    if (
      !subagent &&
      process.env.AGENTDECK_SPLIT_CHILD === '1' &&
      (ownTaskPolled(command, text) || ownBackgroundLog(command, text))
    ) {
      return deny(
        `bg-wait-guard: sleeping ${wait} on the output of a background command this split-group run started ` +
          'is blind polling, and repeating the call does not lift it. End the turn saying what is running: ' +
          'the panel holds the next stage while that command lives and wakes this session with its result. ' +
          'Waiting for a server to come up → poll it (`until curl -s …; do sleep 2; done`).',
      );
    }
    // Polling this session's own background command has no excuse to repeat: a group repeated the
    // refused 575 s loop five seconds later (18.10.2026). A subagent keeps the escape — it is not
    // reliably woken by its own command.
    if (!subagent && ownTaskPolled(command, text)) {
      return deny(ownTaskReason(wait));
    }
    const events = toolEvents(readTail(transcript));
    if (wasJustRefused(events, tool, (o) => String(o?.command ?? '') === command)) return null;
  } catch {
    /* no transcript → judge the command alone */
  }
  if (subagent) {
    return deny(
      `bg-wait-guard: sleeping ${wait} then reading an output is blind polling (short sleeps in a loop add up). In a subagent run the long command ` +
        'in the FOREGROUND instead — Bash with timeout up to 600000 ms — and read its output once; over 10 min → ' +
        'narrow it (one file, --quick) or split it. Waiting for a condition (a server up) → a short poll loop with ' +
        'a timeout. Repeat this exact call if the wait is not on a command you started.',
    );
  }
  return deny(
    `bg-wait-guard: sleeping ${wait} then reading an output is blind polling (short sleeps in a loop add up). A background command wakes you with ` +
      'its completion notification — do other work or end the turn saying what is running. Waiting for a ' +
      'condition (a server up) → poll it with a short loop and a timeout. Repeat this exact call if the wait ' +
      'is not on a background command of this session.',
  );
}
