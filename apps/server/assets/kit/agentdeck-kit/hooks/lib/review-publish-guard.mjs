// A review comment may not be written against a stale read of the thread list.
//
// Incident: the discussions call returned only system notes, two humans had already reviewed, and
// three of their findings went out again forty minutes later under the agent's name.
// Re-raising what a colleague already posted costs more trust than the findings were worth, and no
// amount of care prevents it — the list simply goes stale while a review is being written.
//
// So the re-read is a gate, not a habit: a write into an MR requires a discussions read of THAT MR
// within FRESH_MS, and a positional (inline) note additionally requires the version shas, since a
// position built on remembered shas lands on the wrong line or is rejected outright.
//
// No repeat hatch. The convention of the other guards — repeat the identical call
// and it goes through — turned this one into a formality: the second attempt passed with nothing
// re-read, and the test suite pinned that as intended. What opens the gate now is evidence, in two lines:
//   1. the exact key — a read that named the MR the way the write names it;
//   2. after a refusal only — a read that FOLLOWED it and names the same iid in another shape (numeric
//      project id vs path), or names no MR at all. Looser evidence is accepted only as a deliberate
//      answer to the refusal, never as something that happened to be lying around.
// A thread list that cannot be read at all is the user's call: AGENTDECK_KIT_REVIEW_GUARD=0 (or
// CLAUDE_REVIEW_GUARD=0) in the CLI's environment, which no tool call can set.
//
// Two surfaces, one gate. A GitLab MCP server (whatever name it is attached under) and the forge CLIs
// over the user's own login: `glab mr note`, `gh pr comment|review`, and their `api` forms. A CLI
// call names the MR/PR by number only, so its key is `cli#<iid>` on both the read and the write side.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stateDir } from './kit-paths.mjs';

const CACHE = stateDir('review') ?? '';
const FRESH_MS = 15 * 60 * 1000;

// Writes that publish review content into a merge request. `update_*` is deliberately absent: editing
// your own note back is not a new claim against the thread list.
const GITLAB = 'mcp__[^_]*gitlab[^_]*__';
const REVIEW_WRITE = new RegExp(
  `^${GITLAB}(create_merge_request_thread|create_draft_note|create_merge_request_note|create_merge_request_discussion_note|bulk_publish_draft_notes)$`,
  'i',
);
const POSITIONAL = new RegExp(`^${GITLAB}(create_merge_request_thread|create_draft_note)$`, 'i');
const DISCUSSIONS_READ = new RegExp(
  `^${GITLAB}(mr_discussions|list_merge_request_discussions|get_merge_request_discussion)$`,
  'i',
);
const VERSIONS_READ = new RegExp(
  `^${GITLAB}(list_merge_request_versions|get_merge_request_version)$`,
  'i',
);

// Forge CLIs. The number is the first bare integer after the subcommand, or the one in a pasted URL.
const NUM = String.raw`(?:[^\n;&|]*?(?:\/(?:pull|merge_requests)\/|\s!?#?)(\d+)\b)`;
const CLI_WRITE = [
  new RegExp(String.raw`\bglab\s+mr\s+(?:note|comment)\b(?:\s+create\b)?${NUM}`),
  new RegExp(String.raw`\bgh\s+pr\s+comment\b${NUM}`),
  new RegExp(
    String.raw`\bgh\s+pr\s+review\b(?=[^\n;&|]*\s(?:-b|--body|-c|--comment|-r|--request-changes)\b)${NUM}`,
  ),
  new RegExp(
    String.raw`\b(?:glab|gh)\s+api\b(?=[^\n;&|]*(?:-X\s*POST|--method\s+POST|\s-f\s|\s-F\s|--field|--raw-field))[^\n;&|]*?\/(?:merge_requests|pulls|issues)\/(\d+)\/(?:discussions|notes|comments|reviews)`,
    'i',
  ),
];
const CLI_READ = [
  new RegExp(String.raw`\b(?:glab\s+mr|gh\s+pr)\s+view\b(?=[^\n;&|]*\s(?:-c|--comments)\b)${NUM}`),
  new RegExp(
    String.raw`\b(?:glab|gh)\s+api\b(?![^\n;&|]*(?:-X\s*POST|--method\s+POST))[^\n;&|]*?\/(?:merge_requests|pulls|issues)\/(\d+)\/(?:discussions|notes|comments|reviews)`,
    'i',
  ),
];

/** `{iid}` of a forge-CLI review write / thread read in a Bash command, or null. */
function cliMatch(input, patterns) {
  if (!/^(Bash|PowerShell)$/.test(String(input?.tool_name ?? ''))) return null;
  const cmd = String(input?.tool_input?.command ?? '');
  for (const re of patterns) {
    const m = re.exec(cmd);
    if (m?.[1]) return { iid: m[1] };
  }
  return null;
}

/** A CLI call reshaped as the MCP input the key functions read. */
const asCli = (input, iid) => ({
  ...input,
  tool_input: { project_id: 'cli', merge_request_iid: iid },
});

const sessionKey = (session) => String(session ?? 'x').slice(0, 12);

/** The iid a call is about, as a string; null when the input does not name one. */
function iidOf(input) {
  const i = input?.tool_input ?? {};
  const iid = i.merge_request_iid ?? i.mergeRequestIid ?? i.iid;
  return iid === undefined || iid === null || iid === '' ? null : String(iid);
}

/** The MR a call is about, as a cache-safe key; null when the input does not name one. */
function mrKey(input, session) {
  const i = input?.tool_input ?? {};
  const iid = iidOf(input);
  const project = i.project_id ?? i.projectId ?? i.id ?? i.namespace ?? '';
  if (iid === null) return null;
  const safe = `${project}#${iid}`.replace(/[^\w.#@-]/g, '_').slice(0, 60);
  return join(CACHE, `review-${sessionKey(session)}-${safe}.json`);
}

/** Session-wide record of reads the exact key cannot see: `{ d: {iid: ts}, v: {iid: ts}, dAny, vAny }`. */
const sessionPath = (session) => join(CACHE, `review-${sessionKey(session)}-_session.json`);

function load(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function save(path, patch) {
  try {
    writeFileSync(path, JSON.stringify({ ...load(path), ...patch }));
  } catch {
    /* an unwritable cache must never break a tool call; the guard then asks once more, which is safe */
  }
}

/**
 * PostToolUse module: remember that this MR's thread list (or its shas) was actually read.
 * Always silent — it records, it never speaks.
 */
export function recordReviewRead(input) {
  if (!CACHE) return null;
  const cli = cliMatch(input, CLI_READ);
  if (cli) input = asCli(input, cli.iid);
  const tool = String(input?.tool_name ?? '');
  const discussions = Boolean(cli) || DISCUSSIONS_READ.test(tool);
  if (!discussions && !VERSIONS_READ.test(tool)) return null;
  const now = Date.now();
  const path = mrKey(input, input?.session_id);
  if (path) save(path, discussions ? { discussions: now } : { versions: now });

  const sess = sessionPath(input?.session_id);
  const iid = iidOf(input);
  if (iid === null) save(sess, discussions ? { dAny: now } : { vAny: now });
  else {
    const slot = discussions ? 'd' : 'v';
    save(sess, { [slot]: { ...(load(sess)[slot] ?? {}), [iid]: now } });
  }
  return null;
}

/** PreToolUse module: block a review write built on a stale or absent read. */
export default function reviewPublishGuard(input) {
  if (process.env.AGENTDECK_KIT_REVIEW_GUARD === '0' || process.env.CLAUDE_REVIEW_GUARD === '0')
    return null;
  if (!CACHE) return null;
  const cli = cliMatch(input, CLI_WRITE);
  if (cli) input = asCli(input, cli.iid);
  const tool = String(input?.tool_name ?? '');
  if (!cli && !REVIEW_WRITE.test(tool)) return null;

  const path = mrKey(input, input?.session_id);
  // bulk_publish_draft_notes and friends may not name the MR in a shape we recognise. A guard that
  // cannot identify its subject says nothing rather than blocking an unrelated call.
  if (!path) return null;

  const now = Date.now();
  const state = load(path);
  const positional = !cli && POSITIONAL.test(tool);

  // Line 1 — the exact key.
  const exactD = Number(state.discussions ?? 0);
  let discussionsOk = exactD > now - FRESH_MS;
  let versionsOk = !positional || Boolean(state.versions);

  // Line 2 — after a refusal only: evidence that FOLLOWED it, matched by iid or not keyed at all.
  const deniedAt = Number(state.deniedAt ?? 0);
  if (deniedAt && !(discussionsOk && versionsOk)) {
    const sess = load(sessionPath(input?.session_id));
    const iid = iidOf(input);
    const after = (byIid, any) => {
      const t = Math.max(Number(byIid?.[iid] ?? 0), Number(any ?? 0));
      return t > deniedAt ? t : 0;
    };
    discussionsOk ||= after(sess.d, sess.dAny) > now - FRESH_MS;
    versionsOk ||= after(sess.v, sess.vAny) > 0;
  }
  if (discussionsOk && versionsOk) return null;

  const missing = [];
  if (!discussionsOk)
    missing.push(
      `${cli ? 'the thread list (glab mr view -c / gh pr view --comments)' : 'mr_discussions'}${exactD ? ' (read is older than 15 min)' : ''}`,
    );
  if (!versionsOk) missing.push('list_merge_request_versions');

  const fingerprint = createHash('sha1')
    .update(tool)
    .update(JSON.stringify(input?.tool_input ?? {}))
    .digest('hex')
    .slice(0, 16);
  const repeated = state.retry === fingerprint;
  // The FIRST refusal is the mark evidence has to follow. A later one must not move it past a re-read
  // that already happened: discussions re-read, versions still owed → that re-read stays valid.
  save(path, { retry: fingerprint, deniedAt: deniedAt || now });

  return {
    decision: 'deny',
    reason:
      (repeated ? 'Repeating the call does not open this gate — only the read does. ' : '') +
      `Review write blocked: ${missing.join(' + ')} not read for this MR in this session. ` +
      'Threads arrive while a review is being written — re-read the list, drop anything a human already ' +
      'raised, check the head sha has not moved, then send the write. A list that cannot be read at all → ' +
      'stop and tell the user, never publish blind. Rule: skill agentdeck-kit:situational-rules → review-depth.',
  };
}
