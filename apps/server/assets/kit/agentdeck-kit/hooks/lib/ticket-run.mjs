// A ticket delivery run that outlives the context window.
//
// Door C in `git-guard` and the two review spawns of `agentdeck-kit:ticket-delivery` hang on one fact: the
// user handed a ticket over and asked for the conveyor to run by itself. Both used to read that
// fact out of the user's own words in the window — and a compaction or a `/clear` erases exactly
// those words, in the longest runs, which is where the grant matters most. Measured on two real
// tickets: the branch was refused at stage 2 because the handover sat on the other side
// of a compaction, and the autonomous run stopped to ask for permission it already had.
//
// The run's own ledger is the durable record: `.agent/tickets/<KEY>.agent.md`, with
// `<KEY>.sessions.json` naming the sessions that wrote into it. The skill creates it at stage 1 and
// closes it at stage 14, so it is live for exactly as long as the grant should be, and nothing
// outside the project can forge it.
//
// Narrow on purpose: THIS session must be a participant of the run, and the ledger must still be
// open. Callers keep every other axis of their own narrowing — the repository, the operation set,
// the per-run cap. A grant this wide is only safe while each of those stays in place.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The run is over when the report is written, or when it stopped on a question and nothing followed:
 * the LAST verdict line is `stop`. A `stop` the run later moved past (the user answered, stages went
 * on) closes nothing — same rule as the ledger's own `check`.
 */
function runClosed(body) {
  if (/^- 14-report\s+—/m.test(body)) return true;
  const verdicts = [...body.matchAll(/^-\s+\S+\s+—\s+(ok|red|skip|stop)\s+—/gim)];
  return verdicts.at(-1)?.[1].toLowerCase() === 'stop';
}

/** `.agent/tickets` of the working copy, found from `cwd` upward — a Bash call may sit in a subdir. */
function ticketsDir(cwd) {
  let dir = cwd;
  for (let i = 0; i < 8 && dir; i += 1) {
    const candidate = join(dir, '.agent', 'tickets');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Latest verdict per stage of one ledger body: `{ '06-gates': 'red', ... }`. */
function lastVerdicts(body) {
  const out = {};
  for (const m of body.matchAll(/^- ([a-z0-9-]+) — (ok|red|skip|stop) — /gim))
    out[m[1].toLowerCase()] = m[2].toLowerCase();
  return out;
}

/**
 * Ledger facts for the tracker keys a branch name carries (`PROJ-777-x`, `feature/abc-12`), read from
 * the `.agent/tickets` above `cwd`. Keys without a ledger are left out. Never throws.
 * @returns {{key: string, stages: Record<string, string>}[]}
 */
export function branchLedgers(cwd, branch) {
  try {
    const keys = [
      ...new Set(
        [
          ...String(branch ?? '').matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,9}-\d+)(?!\d)/g),
        ].map((m) => m[1].toUpperCase()),
      ),
    ];
    const dir = keys.length ? ticketsDir(String(cwd ?? '')) : null;
    if (!dir) return [];
    return keys
      .map((key) => ({ key, file: join(dir, `${key}.agent.md`) }))
      .filter(({ file }) => existsSync(file))
      .map(({ key, file }) => ({ key, stages: lastVerdicts(readFileSync(file, 'utf8')) }));
  } catch {
    return [];
  }
}

/**
 * Ticket ids whose ledger this session has open; `[]` when there is no live run.
 * @param {{cwd?: string, session_id?: string}} input hook input
 * @returns {string[]}
 */
export function liveTicketRuns(input) {
  const cwd = String(input?.cwd ?? process.cwd() ?? '');
  const me = String(input?.session_id ?? '');
  if (!cwd || !me) return [];

  try {
    const dir = ticketsDir(cwd);
    if (!dir) return [];
    const open = [];
    for (const name of readdirSync(dir)) {
      const m = name.match(/^([A-Za-z][A-Za-z0-9]{0,9}-\d+)\.sessions\.json$/i);
      if (!m) continue;
      const { sessions } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!Array.isArray(sessions) || !sessions.map(String).includes(me)) continue;
      const ledger = join(dir, `${m[1]}.agent.md`);
      if (!existsSync(ledger)) continue;
      const stages = readFileSync(ledger, 'utf8');
      if (runClosed(stages)) continue;
      open.push(m[1].toUpperCase());
    }
    return open;
  } catch {
    // An unreadable ledger is not a grant: fall back to the ordinary doors.
    return [];
  }
}
