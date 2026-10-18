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
  toolEvents,
  wasJustRefused,
} from './transcript.mjs';
import { bareCommand } from './gate-at-end.mjs';

const SLEEP = /(?:^|&&|;|\n)\s*(?:sleep|Start-Sleep(?:\s+-s(?:econds)?)?)\s+(\d+)/i;
// `.log`/`.output` as a file name, not a call: `console.log(` in a node -e probe is no log read.
const READS_OUTPUT =
  /[\\/]tasks[\\/][^\s"']+\.output|\.(?:output|log)\b(?!\s*\()|\btail\b|\bjournal\b|mustfail/i;

export default function bgWaitGuard(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(input.tool_input?.command ?? '');
  const m = SLEEP.exec(bareCommand(command));
  if (!m || Number(m[1]) < 20 || !READS_OUTPUT.test(command)) return null;
  try {
    const events = toolEvents(readTail(ownTranscript(input)));
    if (wasJustRefused(events, tool, (o) => String(o?.command ?? '') === command)) return null;
  } catch {
    /* no transcript → judge the command alone */
  }
  if (inSubagent(input)) {
    return deny(
      `bg-wait-guard: sleep ${m[1]} then reading an output is blind polling. In a subagent run the long command ` +
        'in the FOREGROUND instead — Bash with timeout up to 600000 ms — and read its output once; over 10 min → ' +
        'narrow it (one file, --quick) or split it. Waiting for a condition (a server up) → a short poll loop with ' +
        'a timeout. Repeat this exact call if the wait is not on a command you started.',
    );
  }
  return deny(
    `bg-wait-guard: sleep ${m[1]} then reading an output is blind polling. A background command wakes you with ` +
      'its completion notification — do other work or end the turn saying what is running. Waiting for a ' +
      'condition (a server up) → poll it with a short loop and a timeout. Repeat this exact call if the wait ' +
      'is not on a background command of this session.',
  );
}
