// PreToolUse(Bash|PowerShell): no sleep-polling of a background command, main session or subagent.
//
// A background command announces its end with a task notification that wakes the session by itself.
// Sleeping on it is blind waiting billed as wall time (measured: one review lane spent 16 min in five
// `sleep 120…280; tail <output>` rounds; a session slept 200 s on its own gate). Denied:
// `sleep`/`Start-Sleep` of 20 s or more whose command then reads a task output or a log. A fixed wait
// for a server to boot stays allowed — poll the condition instead (`until curl -s …; do sleep 2; done`).
// Subagents are covered too (measured week: 93 sleeps / 206 min in lanes): a lane is not reliably woken by
// its own background command, so its denial says the other way — run the long check in the FOREGROUND with
// a timeout and read the output once.
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
const AWAITS_RUN =
  /[\\/]tasks[\\/][^\s"']+\.output|[\w.-]*(?:gate|test|check|lint|tsc|type|build|vitest|jest|mustfail|ci)[\w.-]*\.log\b/i;
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

const ownTaskReason = (wait) =>
  `bg-wait-guard: sleeping ${wait} on the output of a background command THIS session started is blind ` +
  'polling, and repeating the call does not lift it: the CLI wakes the session with a completion ' +
  'notification when the command ends. Do other work, or end the turn saying what is running.';

export default function bgWaitGuard(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(input.tool_input?.command ?? '');
  const total = sleepTotal(command);
  if (total < 20) return null;
  const wait = Number.isFinite(total) ? `${Math.round(total)} s` : 'an unbounded loop';
  const subagent = inSubagent(input);
  try {
    const transcript = ownTranscript(input);
    // Polling this session's own background command has no excuse to repeat: a group repeated the
    // refused 575 s loop five seconds later (18.10.2026). A subagent keeps the escape — it is not
    // reliably woken by its own command.
    if (!subagent && ownTaskPolled(command, readTailText(transcript, OWN_TASK_BYTES))) {
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
