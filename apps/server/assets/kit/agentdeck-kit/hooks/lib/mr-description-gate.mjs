// mr-description-gate — in a panel group run, a RE-post of the MR description waits for a passing delivery check.
//
// Audit g9 27.10 (R5): the deliver stage posted the description (~10k chars) at 02:28, ran the panel's delivery
// check, posted it again at 02:32, ended the turn, got a panel round, and posted a third time at 02:38 — each post
// a whole description of output, each correction found only after it was published. The first post stays free:
// the nudge brief says «post the MR description once, then run delivery», which reads the live MR (F-14, audit g0
// 25.10 — a draft file plus the same text in the forge is two writes when one is enough). A second post goes
// through the draft check instead: the latest `tests-cli … delivery` run after the previous post and after the
// last user (panel) message must have printed «Delivery: nothing left before the answer.».
//
// Description post = forge MCP `update_merge_request` with a description, `update_pull_request` with a body,
// `glab mr update … --description|-d`, `gh pr edit … --body|-b|--body-file|-F`. Opening the MR is not gated.
// Claude transcript only: on another CLI the history reads empty and every post passes.
// Escape: the identical call repeated (delivery can stay red for a reason the description cannot close).
import {
  readTail,
  toolEvents,
  lastUserSpeech,
  wasBlocked,
  wasJustRefused,
  ownTranscript,
  deny,
} from './transcript.mjs';

const MCP_MR = /(?:^|_)update_merge_request$/i;
const MCP_PR = /(?:^|_)update_pull_request$/i;
const CLI_GLAB = /(?:^|[\s;&|(])glab\s+mr\s+update\b[^;&|\n]*?\s(?:--description\b|-d\b)/;
const CLI_GH = /(?:^|[\s;&|(])gh\s+pr\s+edit\b[^;&|\n]*?\s(?:--body(?:-file)?\b|-b\b|-F\b)/;
const SHELL = /^(?:Bash|PowerShell)$/;
// Matched on the raw command: the CLI path usually sits in quotes. The proof is the printed verdict line, not the name.
const DELIVERY =
  /\btests-cli(?:\.mjs)?\b[^;&|\n]*?\sdelivery\b|\bpnpm\s+(?:run\s+)?tests\s+delivery\b/;
const PASSED = 'Delivery: nothing left before the answer.';

const unquoted = (command) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
const filled = (v) => typeof v === 'string' && v.trim() !== '';

/** Does this call publish an MR/PR description? */
export function isDescriptionPost(name, toolInput) {
  const tool = String(name ?? '');
  if (MCP_MR.test(tool)) return filled(toolInput?.description);
  if (MCP_PR.test(tool)) return filled(toolInput?.body);
  if (!SHELL.test(tool)) return false;
  const command = unquoted(String(toolInput?.command ?? ''));
  return CLI_GLAB.test(command) || CLI_GH.test(command);
}

const isDeliveryRun = (name, toolInput) =>
  SHELL.test(String(name ?? '')) && DELIVERY.test(String(toolInput?.command ?? ''));

/** Tool uses with their record index and result, oldest → newest; a use with no result yet is skipped. */
function executedUses(records) {
  const results = new Map();
  for (const e of toolEvents(records)) if (e.kind === 'result') results.set(e.id, e);
  const out = [];
  records.forEach((r, index) => {
    const content = r?.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type !== 'tool_use') continue;
      const res = results.get(c.id);
      if (!res || wasBlocked(res.body)) continue;
      out.push({ index, name: c.name, input: c.input || {}, res, ts: r.timestamp });
    }
  });
  return out;
}

const hhmm = (ts) => {
  const d = new Date(ts ?? '');
  return Number.isNaN(d.getTime()) ? 'earlier' : d.toTimeString().slice(0, 5);
};

export default function mrDescriptionGate(input) {
  if (!String(process.env.AGENTDECK_GROUP_STAGE ?? '').trim()) return null;
  const tool = String(input?.tool_name ?? '');
  const toolInput = input?.tool_input ?? {};
  if (!isDescriptionPost(tool, toolInput)) return null;
  const records = readTail(ownTranscript(input));
  const uses = executedUses(records);
  const post = uses.findLast((u) => isDescriptionPost(u.name, u.input));
  if (!post) return null;
  const since = Math.max(post.index, lastUserSpeech(records).index);
  const check = uses.findLast((u) => u.index > since && isDeliveryRun(u.name, u.input));
  // The verdict line prints only when nothing is left (exit 0); a later command of the same chain cannot unprint it.
  if (check && String(check.res.body ?? '').includes(PASSED)) return null;
  const same = JSON.stringify(toolInput);
  if (wasJustRefused(toolEvents(records), tool, (i) => JSON.stringify(i) === same)) return null;
  return deny(
    `mr-description-gate: this MR description was already posted at ${hhmm(post.ts)}, and no delivery ` +
      `check has passed since${check ? ' (the latest one still lists gaps)' : ''}. A re-post goes through ` +
      'the draft check: write the new text to a file, run the delivery check your brief names (`tests-cli … ' +
      'delivery --project . --answer <sieves file> --mr-description <that file>`) until it prints ' +
      `«${PASSED}», then post that text once. If the check stays red for a reason the description cannot ` +
      'close, repeat this exact call.',
  );
}
