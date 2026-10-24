#!/usr/bin/env node
/**
 * Replay of REAL transcript tool calls through the panel's REAL permission decision functions —
 * the same order as `/api/chat/permission-request` (`routes/chat/run-routes/run-routes.ts`).
 * Answers one question: which calls of groups (and panel single chats) would wait on the human
 * today, and is any of them routine by the owner's policy (`group-asks-oracle.mjs`).
 *
 * Executes nothing it replays. The only processes it starts are read-only `git` queries the real
 * functions make themselves (`rev-parse`, `symbolic-ref`, `ls-files`, `merge-base` inside
 * `isHiddenSync`) in copies that still exist. Transcripts, `state.json`, settings: read only.
 *
 * What cannot be replayed offline and how it is treated (printed in the header):
 *   - MR state: forge not read → `mrInReview` unknown (= "in review", as the route does on a forge
 *     failure); a lease push of a group with an MR is then an agent refusal, not a card;
 *   - process facts (kills by pid/port): no live process tree of a dead run → counted human,
 *     bucket "kill: process facts not replayable";
 *   - uncommitted-work guard: the historical tree is unknown → replayed as CLEAN through the
 *     function's IO seam (status = '', snapshot is a fake ref) — no backup ref is ever written;
 *   - main sync: the historical conflict is unknown → a sole `rebase/merge/pull` of the target is
 *     "allow on conflict, agent refusal without" (never a card); a compound sync is judged
 *     worst-case (conflict) = by the group rows;
 *   - the copy's branch: the transcript's `gitBranch` when the copy is gone or now on another
 *     branch; ignored-file facts: today's copy;
 *   - every call is counted as if the CLI forwarded it to the bridge (upper bound): the CLI's own
 *     auto mode and allow rules let most of them through before the bridge ever sees them. The
 *     subset a group's CLI `ask` rules touch (`GROUP_DANGER_ASK` + `MAIN_SYNC_ASK` + forge/tracker
 *     MCP, read live) is printed beside it — the realistic count in `--permission-mode auto`.
 *
 * Outcome `deferred` (23.10): a group call the human decides becomes a D-n at once (no card, the
 * run goes on); it still counts as human-bound — routine D-n fails, critical D-n is the design.
 *
 * Exit 0 — no routine group call is human-bound (except the rows `KNOWN_ROWS` names one by one,
 * each with its reason), every danger fixture reaches the human (or is refused), every routine
 * fixture passes without the human. Exit 1 — any of these fails (lines
 * printed). Exit 2 — harness problem (route order drifted, a module failed to load).
 *
 * Usage: node tools/qa/check-group-asks-replay.mjs [--since 2026-10-16] [--no-singles]
 *          [--include-temp] [--max 30] [--out <file.json>] [--strict-singles]
 */
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DANGER_FIXTURES,
  ROUTINE_FIXTURES,
  copyRootOf,
  norm,
  oracleClass,
  simpleCommands,
} from './group-asks-oracle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRV = join(ROOT, 'apps', 'server', 'src');
const CONTRACTS = join(ROOT, 'packages', 'contracts', 'src');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const CONFIG = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const PROJECTS = opt('projects', join(CONFIG, 'projects'));
const STATE = opt('state', join(CONFIG, 'agentdeck', 'state.json'));
const SINCE = Date.parse(
  opt('since', new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)),
);
const MAX = Number(opt('max', '30'));
const OUT = opt('out', undefined);

const harness = (message) => {
  console.error(`group-asks-replay: HARNESS ${message}`);
  process.exit(2);
};

// ------------------------------------------------------------ route fingerprint

const ROUTE_FILE = join(SRV, 'routes', 'chat', 'run-routes', 'run-routes.ts');
const ROUTE_ORDER = [
  'planAnswers(',
  'pickRecommended(',
  'adoptFromLedger(',
  'RUN_UNKNOWN_DENIED',
  'reachesPanelDecision(',
  'consume(',
  'deliveryRefusal(',
  'isWritingCall(',
  'isMainWorkingCopy(',
  'mainCopyTargetOf(',
  'guardHitFor(',
  'groupAutoApproveFor(',
  'withWorktree(',
  'toolCallCwd(',
  'withProcessFacts(',
  'withMrState(',
  'guardUncommitted(',
  'groupDiscards(',
  'groupDecision(',
  'groupPushRefusal(',
  'resolvedSyncText(',
  'expandAliasText(',
  'syncRefOf(',
  'conflictsWith(',
  'isSoleSync(',
  'syncDanger(',
  'gitDestroys(',
  'shouldAutoApprove(',
  'protectedWriteRefusal(',
  'retryOf(',
  'requestPermission(',
];
// 24 since the D-n bridge (23.10): self-approval refusal, one-shot grants, delivery while a
// D-n waits, group/unattended branch gate, merge refusal and the D-n deny joined the 14.
// 26 since D-S02 (23.10): the protected-write refusal moved before the card for every chat and
// a repeat of a queued/refused call answers from the record (`retryOf`).
// 28 since the plan-answer re-ask cap (F-128, 24.10): `AskUserQuestion` answered by plan now
// has a capped deny and a split recorded-notice path — both deny without a human, as modelled.
const ROUTE_EXITS = 28;
{
  const src = readFileSync(ROUTE_FILE, 'utf8');
  const start = src.indexOf("'/api/chat/permission-request'");
  const end = src.indexOf("'/api/chat/:chatId/permission-decision'");
  if (start < 0 || end < 0) harness(`permission-request handler not found in ${ROUTE_FILE}`);
  const body = src.slice(start, end);
  let at = 0;
  for (const step of ROUTE_ORDER) {
    const next = body.indexOf(step, at);
    if (next < 0) harness(`route order drifted at "${step}" — update the replay to the new order`);
    at = next + step.length;
  }
  const exits = body.split('reply.send(').length - 1;
  if (exits !== ROUTE_EXITS)
    harness(`route has ${exits} exits, the replay knows ${ROUTE_EXITS} — re-read the handler`);
}

// ------------------------------------------------------------ real modules

const load = async (dir, rel) => {
  try {
    return await import(pathToFileURL(join(dir, rel)).href);
  } catch (error) {
    harness(`cannot load ${rel}: ${error?.message ?? error}`);
  }
};
const gp = await load(SRV, 'domains/chat/group-permissions.ts');
const aa = await load(SRV, 'domains/chat/auto-approve/auto-approve.ts');
const ms = await load(SRV, 'domains/chat/main-sync/main-sync.ts');
const bg = await load(SRV, 'domains/chat/ChatBranchGate/ChatBranchGate.ts');
const guardMod = await load(SRV, 'domains/backend-guard/backend-guard.ts');
const tests = await load(SRV, 'domains/project-tests/project-tests.ts');
const tcc = await load(SRV, 'domains/chat/ChatTranscriptFile/tool-call-cwd.ts');
const perms = await load(SRV, 'domains/permissions/permissions.ts');
const gq = await load(SRV, 'domains/chat/group-questions/group-questions.ts');
const gc = await load(SRV, 'domains/chat/group-command/group-command.ts');
const aliasText = await load(SRV, 'domains/chat/group-command/alias-text.ts');
const treeState = await load(SRV, 'domains/chat/group-tree-state.ts');
const gcr = await load(SRV, 'domains/chat/group-copy-root.ts');
const gprof = await load(SRV, 'domains/chat/group-profile/group-profile.ts');
const dbr = await load(SRV, 'routes/chat/run-routes/deferred-bridge.ts');
// The group's CLI `ask` rules (`outwardAsk`, group-profile.ts): in `--permission-mode auto` ONLY
// calls they touch reach the bridge. Approximated here (glob → regex per simple command); the
// upper bound above stays the exit criterion, this is the realistic subset printed beside it.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CLI_ASK_BASH = [...gprof.GROUP_DANGER_ASK, ...ms.MAIN_SYNC_ASK]
  .map((rule) => /^Bash\(([\s\S]*)\)$/.exec(rule)?.[1])
  .filter((glob) => glob !== undefined)
  .map((glob) => new RegExp(`^${glob.split('*').map(escapeRe).join('[\\s\\S]*')}$`));
const FORGE_MCP = /^mcp__[\w-]*(gitlab|github|atlassian|jira|confluence)/i;
function forwardedByCli(toolName, input) {
  if (toolName === 'AskUserQuestion') return true;
  if (toolName.startsWith('mcp__')) return FORGE_MCP.test(toolName);
  if (toolName !== 'Bash') return false;
  const command = String(input?.command ?? '');
  const parts = simpleCommands(command);
  if (parts === null) return true;
  const segments = [command, ...parts.map((p) => p.words.join(' '))];
  return segments.some((s) => CLI_ASK_BASH.some((re) => re.test(s.trim())));
}
const REPLAY_TREE_IO = {
  status: async () => '',
  snapshot: async () => ({ ref: 'refs/agentdeck/backup/replay-not-written' }),
};
const splitSettings = await load(SRV, 'lib/app-store/split-settings/split-settings.ts');
const cgs = await load(CONTRACTS, 'chat-group-settings.ts');
const prules = await load(CONTRACTS, 'permission-rules.ts');
const sg = await load(CONTRACTS, 'split-groups.ts');

// ------------------------------------------------------------ state and settings (read only)

const state = JSON.parse(readFileSync(STATE, 'utf8'));
const links = state.chatLinks ?? {};
const aliases = state.chatKeyAliases ?? {};
const plans = state.splitPlans ?? {};
const canon = (key) => {
  let current = key;
  const seen = new Set([key]);
  for (let hop = 0; hop < 20; hop += 1) {
    const next = Object.hasOwn(aliases, current) ? aliases[current] : undefined;
    if (next === undefined || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
};
const reverseAliases = new Map();
for (const [from, to] of Object.entries(aliases)) {
  const target = canon(to);
  if (!reverseAliases.has(target)) reverseAliases.set(target, []);
  reverseAliases.get(target).push(from);
}
// Historical replay: a retired link (group restarted since) still says whose session it was.
const source = {
  getChatLink: (key) => {
    const link = links[key];
    return link
      ? { parentChatId: link.parentChatId, groupIndex: link.groupIndex, branch: link.branch }
      : undefined;
  },
  getSplitPlan: (parent) => plans[parent] ?? plans[canon(parent)],
  getSplitSettings: (path) => splitSettings.getSplitSettings(state, path),
  getSplitDefaults: () => splitSettings.getSplitDefaults(state),
};
const keysOf = (sessionId) => {
  const c = canon(sessionId);
  return [...new Set([sessionId, c, ...(reverseAliases.get(c) ?? [])])];
};
const groupSessions = new Set();
for (const key of Object.keys(links)) {
  const g = gp.groupAutoApproveFor(source, [key]);
  if (g) {
    groupSessions.add(key);
    groupSessions.add(canon(key));
  }
}

const settingsPath = join(CONFIG, 'settings.json');
const settingsLocalPath = join(CONFIG, 'settings.local.json');
const permStore = { getGroupIdsFor: () => [], getDisabledIds: () => [] };
const guardedPatterns = perms.createGuardedPatternsReader(() => ({
  settings: settingsPath,
  settingsLocal: settingsLocalPath,
  store: permStore,
}));
const allowedMcpTools = perms.createAllowedMcpToolsReader(() => ({
  settings: settingsPath,
  settingsLocal: settingsLocalPath,
  store: permStore,
}));
const panelSettings = state.settings ?? {};
const rules = prules.allowedPermissionRules(panelSettings.autoApproveRules);
const chatAuto = { enabled: panelSettings.chatAutoMode !== false, allowEdits: true };
const groupQuestions = splitSettings.getSplitDefaults(state).groupQuestions;
const guardMainOf = guardMod.cachedMainOf(tests.mainCheckoutOf);

// ------------------------------------------------------------ memo around git-reading functions

const mainCopyMemo = new Map();
const isMainCopy = (cwd) => {
  if (!mainCopyMemo.has(cwd)) mainCopyMemo.set(cwd, bg.isMainWorkingCopy(cwd));
  return mainCopyMemo.get(cwd);
};
// `withWorktree` output depends only on cwd, the two internal "needs" tests and git state; the memo
// keys on copies of those tests and is used only while the source still carries them verbatim.
const GP_SRC = readFileSync(join(SRV, 'domains/chat/group-permissions.ts'), 'utf8');
const NEEDS_BRANCH_SRC = String.raw`/\bgit\b[\s\S]*\b(push\b|merge\b|branch\b[\s\S]*(\s-[a-zA-Z]*[dD]\b|--delete\b))/`;
const NEEDS_IGNORED_SRC =
  String.raw`/(^|[\s;&|(` +
  '`' +
  String.raw`'"])(rm|rmdir|rd|del|erase|unlink|shred|remove-item)(\s|$)|\bgit\b[\s\S]*\b(restore|checkout|rm)\b|\s-delete\b/i`;
const memoSafe = GP_SRC.includes(NEEDS_BRANCH_SRC) && GP_SRC.includes(NEEDS_IGNORED_SRC);
const NEEDS_BRANCH =
  /\bgit\b[\s\S]*\b(push\b|merge\b|branch\b[\s\S]*(\s-[a-zA-Z]*[dD]\b|--delete\b))/;
const NEEDS_IGNORED =
  /(^|[\s;&|(`'"])(rm|rmdir|rd|del|erase|unlink|shred|remove-item)(\s|$)|\bgit\b[\s\S]*\b(restore|checkout|rm)\b|\s-delete\b/i;
/** Same test as `needsPrunable` in group-permissions.ts: the command needs the prunable list. */
const NEEDS_PRUNABLE = /\bgit\b[\s\S]*\bworktree\b[\s\S]*\bprune\b/;
/**
 * `git worktree list` of the run's repository, as `recordBranchCopy` reads it — plus the group's
 * recorded copy (split record `path` on `branch`) when it is gone from disk now: while the group
 * ran, the repository listed it. A copy the record does not name is never added.
 */
const worktreeIoFor = (copyPath, branch) => ({
  list: async (root) => {
    const live = await gcr.realWorktreeListIo.list(root);
    if (!live || !copyPath || !branch) return live;
    const listed = live
      .split(/\r?\n/)
      .some((line) => line.startsWith('worktree ') && norm(line.slice(9)) === norm(copyPath));
    if (listed) return live;
    facts.recordedCopies += 1;
    return `${live.replace(/\s+$/, '')}\n\nworktree ${copyPath}\nHEAD 0000000000000000000000000000000000000000\nbranch refs/heads/${branch}\n`;
  },
});
const worktreeMemo = new Map();
const placeGroup = async (group, cwd, request, copyPath) => {
  const command = request.toolName === 'Bash' ? String(request.input?.command ?? '') : '';
  const io = worktreeIoFor(copyPath, group.branch);
  const key = memoSafe
    ? `${cwd}\0${group.branch ?? ''}\0${copyPath ?? ''}\0${command ? NEEDS_IGNORED.test(command) : false}\0${command ? NEEDS_BRANCH.test(command) : false}\0${command ? NEEDS_PRUNABLE.test(command) : false}`
    : `${cwd}\0${group.branch ?? ''}\0${copyPath ?? ''}\0${request.toolName}\0${command}`;
  if (!cwd) return gp.withWorktree(group, cwd, request, io);
  if (!worktreeMemo.has(key)) worktreeMemo.set(key, await gp.withWorktree(group, cwd, request, io));
  // Only the git facts come from the memo; the group's own fields (rows, MR) stay this session's.
  const placed = worktreeMemo.get(key);
  return {
    ...group,
    worktree: placed.worktree,
    ...(placed.ignored ? { ignored: placed.ignored } : {}),
    ...(placed.base ? { base: placed.base } : {}),
    ...(placed.ownBranch ? { ownBranch: placed.ownBranch } : {}),
    // Live list now, not at the time of the run: a copy removed since then reads as prunable.
    ...(placed.prunable ? { prunable: placed.prunable } : {}),
  };
};

const writingOutsideCwd = (cwd, toolName, input) => {
  // Sound short-cuts of `mainCopyTargetOf` (it returns undefined in these cases without git):
  // an edit inside the run's own cwd, a shell command naming no drive-letter path at all.
  if (!bg.isWritingCall(toolName, input)) return false;
  if (toolName === 'Bash') return /[a-z]:[\\/]/i.test(String(input?.command ?? ''));
  const file = input?.file_path ?? input?.notebook_path ?? input?.path;
  if (typeof file !== 'string') return true;
  const p = norm(resolve(cwd, file));
  return !(p === norm(cwd) || p.startsWith(`${norm(cwd)}/`));
};

// ------------------------------------------------------------ rows accepted one by one

/**
 * Routine-by-oracle group calls that stay human-bound in the replay, each named by transcript
 * row, decision bucket and the start of its text, with the reason it is not a defect. Only an
 * exact match is accepted: the same row failing for another reason, or any row not listed here,
 * still fails the run. No counts, no thresholds, no patterns (coordinator, 24.10).
 * Classes: `not replayable` — the fact the route reads no longer exists; `oracle wrong` — the
 * oracle's «routine» contradicts a written rule; `by design` — an owner/coordinator decision.
 */
const GONE_COPY =
  "the copy is gone from disk, so `git ls-files --ignored` cannot be read; without ignored-file facts a delete of a non-temp path is the human's (F-29), the live route reads them";
const LEDGER_NOTE =
  'a ticket-ledger note whose quoted text names a database operation; stripping quoted arguments before the row rules would blind `psql -c "DROP …"` (R-C04, rejected)';
const MAIN_NOT_OWN =
  "deletes a file in the MAIN copy while the group's own copy is known (record branch, decision 23.10: the main copy never becomes own); under today's route the earlier write of that file into the main copy is already refused, so the cleanup cannot arise";
const KNOWN_ROWS = [
  [
    '9dd885b1-2f2e-4d28-8a5b-828c2ce2d3ed.jsonl:1352',
    'group: shell verdict danger',
    'cd C:/work/…-worktrees/fix-…-1193',
    'not replayable',
    GONE_COPY,
  ],
  [
    'e1b8312f-099b-4a98-85d6-27a9ee349b30.jsonl:2317',
    'group: shell verdict danger',
    'rm -rf e2e && git status',
    'not replayable',
    GONE_COPY,
  ],
  [
    '2970763f-03b9-4445-984c-90c4910f34e1.jsonl:695',
    'group: shell verdict danger',
    'rm inst-auth/internal/http/zz_sieve886_test.go',
    'not replayable',
    GONE_COPY,
  ],
  [
    'e21eef15-2d31-415e-bd98-474eaa8a52a3.jsonl:821',
    'group: shell verdict danger',
    'cd /c/work/…-worktrees/fix-…-1424',
    'not replayable',
    `node fs.unlinkSync; ${GONE_COPY}`,
  ],
  [
    '047319f9-927f-4b3f-994a-c6df106ee8f8.jsonl:567',
    'group: shell verdict danger',
    'cd inst-auth && go test ./internal/middleware',
    'not replayable',
    GONE_COPY,
  ],
  [
    '047319f9-927f-4b3f-994a-c6df106ee8f8.jsonl:584',
    'group: shell verdict danger',
    'git show HEAD:inst-auth/go.mod',
    'not replayable',
    GONE_COPY,
  ],
  [
    'fe1a588f-6149-42fa-894f-10ab733fe71a.jsonl:312',
    'group: shell verdict danger',
    'cat > inst-auth/internal/middleware/zz_probe_test.go',
    'not replayable',
    GONE_COPY,
  ],
  [
    'agent-a0dc8ecc4f1285978.jsonl:137',
    'group: shell verdict danger',
    'cd C:/work/…-worktrees/review-mr988-scratch',
    'oracle wrong',
    "writes into a SIBLING copy of another group; a write outside the own copy is the human's (A-03)",
  ],
  [
    '96af48d9-a8cd-4b71-9686-357c9a712d1e.jsonl:293',
    'group: shell verdict danger',
    'cd /c/work/…-worktrees/review-mr988-scratch',
    'oracle wrong',
    "writes into a SIBLING copy of another group; a write outside the own copy is the human's (A-03)",
  ],
  [
    '8331c46e-04d3-4235-9813-81052b7b8683.jsonl:2546',
    'group: shell verdict danger',
    'PYTHONIOENCODING=utf-8 python -',
    'oracle wrong',
    'Python `os.remove(d+f)`: the deleted path is computed, nothing static can prove it stays in the copy',
  ],
  [
    'bb69aee9-acb6-4403-aa77-2779333803b1.jsonl:160',
    'group: shell verdict danger',
    'rm /c/work/…/e2e/bl/_…-live.mjs',
    'by design',
    MAIN_NOT_OWN,
  ],
  [
    '58cee4ef-d2ba-42ea-b407-4af246552403.jsonl:1004',
    'group: shell verdict danger',
    'rm C:/work/…/.agent/tmp/…-kbd-probe.mjs',
    'by design',
    MAIN_NOT_OWN,
  ],
  [
    'fda1d042-7f81-49e7-9026-e647b480f6d1.jsonl:51170',
    'group: row human (database)',
    'node ~/.claude/tools/ticket-ledger.mjs add …-1785',
    'by design',
    LEDGER_NOTE,
  ],
  [
    'e1b8312f-099b-4a98-85d6-27a9ee349b30.jsonl:201',
    'group: row human (database)',
    'cd /c/work/…-worktrees/fix-…-1299',
    'by design',
    LEDGER_NOTE,
  ],
  [
    '758653c0-c061-4120-b6c3-60a38bc806fc.jsonl:1106',
    'group: row human (database)',
    'cd /c/work/…-worktrees/fix-…-1459',
    'by design',
    LEDGER_NOTE,
  ],
  [
    '6ae5f585-8ff3-4313-a820-113e87d3f4b3.jsonl:191',
    'group: row human (database)',
    'export PATH="$NVM_HOME/v22.23.2:$PATH"; L=".claude/tools/ticket-ledger.mjs"',
    'by design',
    LEDGER_NOTE,
  ],
  [
    'a2d6fc65-93b2-4e19-9386-2da403249250.jsonl:1690',
    'question: no questions in the call',
    '{"questions":"[',
    'not replayable',
    'the CLI refused the call itself (tool_result InputValidationError: `questions` is a string), so it never reached the bridge',
  ],
].map(([where, reason, starts, cls, why]) => ({ where, reason, starts, cls, why }));
/**
 * `…` in `starts` stands for one path-segment run (no space, no slash): the transcripts name
 * another project and its ticket keys, which this public repository does not carry.
 */
const startsLike = (text, starts) =>
  new RegExp(
    `^${starts
      .split('…')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^\\s/]*?')}`,
  ).test(text);
const knownRow = (h) =>
  KNOWN_ROWS.find(
    (row) => row.where === h.where && row.reason === h.reason && startsLike(h.text, row.starts),
  );
const accepted = [];

// ------------------------------------------------------------ the decision, route order

const facts = {
  copiesLive: 0,
  copiesGone: 0,
  branchFromTranscript: 0,
  mrOffline: 0,
  killsUnreplayed: 0,
  recordedCopies: 0,
  syncSole: 0,
  syncWorst: 0,
};

/** Mirrors the permission-request handler. Returns { outcome, reason }. */
async function decide(call, ctx) {
  const { toolName, input, id } = call;
  const cwd = ctx.cwd;
  if (toolName === 'AskUserQuestion') {
    if (ctx.group && groupQuestions === 'plan') {
      return gq.planAnswers(input)
        ? { outcome: 'auto', reason: 'question: answered by plan' }
        : { outcome: 'human', reason: 'question: no questions in the call' };
    }
    if (ctx.group) return { outcome: 'human', reason: 'question: group questions mode = human' };
    return cgs.pickRecommended(input)
      ? { outcome: 'human?', reason: 'question: chat — auto-pick only if the chat is autonomous' }
      : {
          outcome: 'human',
          reason: 'question: chat, no recommended option (QUESTION_DENIED, answered by message)',
        };
  }
  // D-n bridge order: answering for the human is refused first. One-shot grants and the
  // delivery refusal depend on D-n records of that time — not replayable, never a card either.
  if (dbr.reachesPanelDecision(toolName, input)) {
    return { outcome: 'deny', reason: 'self-approval refusal (agent refusal)' };
  }
  if (
    !rules.has('editInMainCopy') &&
    !ctx.gateSettled &&
    bg.isWritingCall(toolName, input) &&
    cwd &&
    existsSync(cwd) &&
    isMainCopy(cwd)
  ) {
    // A group never waits on the gate: its own copy elsewhere → refusal, none → D-n. Same
    // comparison as the route (`groupCopyOf` vs the run's cwd, trailing slashes cut). The route
    // never settles the gate for a group (only a human «write here» answer does), so every later
    // write of the group in the main copy meets it again.
    if (ctx.group) {
      const own = ctx.copyPath;
      if (own && own.replace(/[\\/]+$/, '') !== cwd.replace(/[\\/]+$/, '')) {
        return {
          outcome: 'deny',
          reason: 'branch gate: group in the main copy, own copy recorded (agent refusal)',
        };
      }
      // One D-n per run: its input is the run's cwd (`mainCopyInput(held.options.cwd)`), the same
      // for every write of the run — a repeat finds it queued. The transcript's `cwd` follows the
      // shell, so the key is the run, not the record's directory.
      if (ctx.gateDeferred?.has('run'))
        return { outcome: 'deny', reason: 'branch gate: D-n already queued (agent refusal)' };
      ctx.gateDeferred?.add('run');
      return { outcome: 'deferred', reason: 'branch gate: group in the main copy' };
    }
    ctx.gateSettled = true;
    return { outcome: 'human', reason: 'branch gate: first write in the main copy' };
  }
  if (
    !rules.has('editInMainCopy') &&
    cwd &&
    existsSync(cwd) &&
    writingOutsideCwd(cwd, toolName, input)
  ) {
    if (bg.mainCopyTargetOf(cwd, toolName, input))
      return { outcome: 'deny', reason: 'into the main copy (agent refusal)' };
  }
  const guard = cwd ? guardMod.guardHitFor(cwd, toolName, input, guardMainOf) : undefined;
  const request = { toolName, input };
  let group;
  if (ctx.group) {
    const placed = await placeGroup(ctx.group, cwd, request, ctx.copyPath);
    const command = toolName === 'Bash' ? String(input?.command ?? '') : '';
    // Transcript `gitBranch: "HEAD"` = detached at the time: the route's `symbolic-ref` returns
    // nothing then, so it is not a branch to stand in for.
    if (
      ctx.branch &&
      ctx.branch !== 'HEAD' &&
      NEEDS_BRANCH.test(command) &&
      !gc.isProtectedBranch(ctx.branch, placed.base) &&
      placed.ownBranch !== ctx.branch
    ) {
      placed.ownBranch = ctx.branch;
      facts.branchFromTranscript += 1;
    }
    const shellCwd = toolName === 'Bash' ? tcc.callCwdIn([call.record], id) : undefined;
    const found = shellCwd ? { ...placed, shellCwd } : placed;
    const kills = gp.killTargetsOf(found, request);
    if (kills && (kills.pids.length || kills.ports.length)) facts.killsUnreplayed += 1;
    const stated = await gp.withProcessFacts(found, request, []);
    if (stated.mr && gp.needsMrState(stated, request)) facts.mrOffline += 1;
    // Uncommitted-work guard: the historical tree is unknown — replayed as CLEAN, through the
    // function's own IO seam, so no snapshot ref is ever written.
    const kept = !guard
      ? await treeState.guardUncommitted(
          stated.worktree,
          command,
          gp.groupDiscards(stated, request),
          REPLAY_TREE_IO,
        )
      : {};
    if ('deny' in kept) return { outcome: 'deny', reason: 'uncommitted guard (agent refusal)' };
    group = kept.tree ? { ...stated, tree: kept.tree } : stated;
  }
  const level = group
    ? gp.groupDecision(group, {
        toolName,
        input,
        guardedPatterns: guardedPatterns(),
        allowedTools: allowedMcpTools(),
      })
    : 'human';
  const refusal = !guard && group ? gp.groupPushRefusal(group, request) : undefined;
  if (refusal)
    return {
      outcome: 'deny',
      reason: 'push refusal: MR in review, no conflict known (agent refusal)',
    };
  const command = String(input?.command ?? '');
  // Mirrors the route's `syncRefOf` (recheck 24.10): text with snapshot aliases expanded (a), a
  // sync whose target cannot be named goes to the human (c), PowerShell judged like Bash;
  // `$(git rev-parse …)` / literal variable targets resolved to the ref (`resolvedSyncText`).
  const syncCommand = ms.resolvedSyncText(
    aliasText.expandAliasText(command, toolName === 'Bash' ? group?.aliases : undefined),
  );
  let syncUnnamed = false;
  if (!guard && group && cwd && (toolName === 'Bash' || toolName === 'PowerShell')) {
    let syncRef;
    if (ms.syncsWithTarget(syncCommand)) {
      const target = ms.syncTarget(syncCommand);
      if (target === undefined || ms.isUnnamedRef(target)) syncUnnamed = true;
      else syncRef = target;
    } else {
      const candidate = ms.syncCandidate(syncCommand);
      if (candidate && ms.isUnnamedRef(candidate)) syncUnnamed = true;
      else if (candidate && existsSync(cwd))
        syncRef = (await ms.isHiddenSync(cwd, candidate, group.base)) ? candidate : undefined;
    }
    if (syncRef) {
      if (ms.isSoleSync(syncCommand) && !gp.syncDanger(group, command, toolName)) {
        facts.syncSole += 1;
        return { outcome: 'auto', reason: 'main sync: allowed on conflict, agent refusal without' };
      }
      facts.syncWorst += 1;
    }
  }
  if (!guard && group && level !== 'human' && !syncUnnamed)
    return { outcome: level, reason: `group rows: ${level}` };
  if (
    !guard &&
    !group &&
    (chatAuto.enabled || aa.isReadOnlyTool(toolName)) &&
    !treeState.gitDestroys(toolName, input) &&
    aa.shouldAutoApprove({
      toolName,
      input,
      guardedPatterns: guardedPatterns(),
      allowedTools: allowedMcpTools(),
      allowEdits: chatAuto.allowEdits,
      allowedRules: rules,
    })
  ) {
    return { outcome: 'auto', reason: 'chat auto-approve' };
  }
  // Merge / push to a protected branch / unprovable push target gets the known refusal BEFORE
  // the card, single chat included (route since D-S02, 23.10); a group's rest is a D-n — the
  // run goes on and the human answers from the list. The historical branch (transcript) stands
  // in for the route's live `symbolic-ref` ("HEAD" there = detached, no branch). The `retryOf`
  // exit after it needs the live D-n queue, which a replay has not: every row is a first ask.
  const branchFacts = {
    ...(ctx.branch && ctx.branch !== 'HEAD' ? { branch: ctx.branch } : {}),
    ...(group?.base ? { base: group.base } : {}),
  };
  if (dbr.mergesOrPushesMain(toolName, input, branchFacts)) {
    return { outcome: 'deny', reason: 'merge / push to main: owner step (agent refusal)' };
  }
  return {
    outcome: group ? 'deferred' : 'human',
    reason: guard
      ? `backend guard: ${guard.label ?? guard.rule ?? 'hit'}`
      : group
        ? groupWhy(group, request)
        : chatWhy(request),
  };
}

function groupWhy(group, request) {
  const { toolName, input } = request;
  const named = aa.ruleFor(toolName, input);
  if (named === 'editInMainCopy') return 'group: edit of the main copy';
  if (toolName === 'Bash') {
    const command = String(input?.command ?? '');
    const verdict = gc.groupCommandVerdict(command, {
      ...(group.worktree ? { worktree: group.worktree } : {}),
      ...(group.shellCwd ? { cwd: group.shellCwd } : {}),
      ...(group.ownBranch ? { branch: group.ownBranch } : {}),
      ...(group.base ? { base: group.base } : {}),
      ...(group.ignored ? { ignored: group.ignored } : {}),
    });
    if (verdict.kind === 'danger') return 'group: shell verdict danger';
    if (verdict.kills && (verdict.kills.pids.length || verdict.kills.ports.length))
      return 'group: kill — process facts not replayable';
    if (verdict.lease && group.mr) return 'group: lease push, MR in review';
    const ids = verdict.kind === 'other' ? [...verdict.rules] : [];
    if (verdict.kind === 'other')
      for (const text of verdict.texts)
        ids.push(aa.ruleFor('Bash', { command: text }) ?? 'routine');
    if (verdict.writes) ids.push('gitWrite');
    if (verdict.deletes) ids.push('filesDelete');
    const human = [...new Set(ids)].filter((id) => group.rows[id] === 'human');
    if (human.length) return `group: row human (${human.join(', ')})`;
    return 'group: settings ask/deny pattern or unknown Bash form';
  }
  if (aa.isReadOnlyTool(toolName)) return 'group: read tool refused (settings deny)';
  if (!group.allowEdits && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName))
    return 'group: edits off (allowEdits=false)';
  if (named && group.rows[named] === 'human') return `group: row human (${named})`;
  return `group: settings ask/deny pattern (${toolName})`;
}

function chatWhy(request) {
  const { toolName, input } = request;
  if (!chatAuto.enabled && !aa.isReadOnlyTool(toolName)) return 'chat: auto-approve off';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName) && !chatAuto.allowEdits)
    return 'chat: edits off';
  const named = aa.ruleFor(toolName, input);
  if (named && !rules.has(named)) return `chat: rule ${named} off`;
  if (toolName === 'Bash' && typeof input?.command !== 'string') return 'chat: unknown Bash form';
  return 'chat: settings ask/deny pattern';
}

// ------------------------------------------------------------ transcripts

function* walkJsonl(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(path);
    else if (entry.name.endsWith('.jsonl')) yield path;
  }
}

const panelMemo = new Map();
/** A panel-spawned single chat: the head of its top transcript carries the SDK entrypoint. */
function panelRun(topFile) {
  if (panelMemo.has(topFile)) return panelMemo.get(topFile);
  let yes;
  try {
    const fd = openSync(topFile, 'r');
    const buf = Buffer.alloc(200_000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    yes = buf.subarray(0, n).toString('utf8').includes('"entrypoint":"sdk-cli"');
  } catch {
    yes = false;
  }
  panelMemo.set(topFile, yes);
  return yes;
}

const isTemp = (name) => /AppData-Local-Temp/i.test(name);
const files = [];
for (const dir of readdirSync(PROJECTS, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  if (isTemp(dir.name) && !flag('include-temp')) continue;
  const full = join(PROJECTS, dir.name);
  const copyDir = /-worktrees-/i.test(dir.name);
  for (const file of walkJsonl(full)) {
    const top = dirname(file) === full;
    const sessionId = top ? basename(file, '.jsonl') : basename(dirname(dirname(file)));
    const linked = groupSessions.has(sessionId) || groupSessions.has(canon(sessionId));
    if (copyDir || linked) {
      files.push({ file, kind: 'group', sessionId, linked });
      continue;
    }
    if (flag('no-singles')) continue;
    const topFile = top ? file : join(full, `${sessionId}.jsonl`);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < SINCE) continue;
    if (!panelRun(topFile)) continue;
    files.push({ file, kind: 'single', sessionId, linked: false });
  }
}

const ASK_HOOK = /Say in chat exactly which command you want to run/;
const tally = { group: newTally(), single: newTally() };
function newTally() {
  return {
    files: 0,
    sessions: new Set(),
    calls: 0,
    byKind: new Map(),
    human: [],
    hookAsks: new Map(),
  };
}
const kindOf = (name) =>
  name === 'Bash'
    ? 'Bash'
    : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)
      ? 'Edit/Write'
      : name.startsWith('mcp__')
        ? `mcp:${name.split('__')[1]}`
        : name === 'AskUserQuestion'
          ? 'AskUserQuestion'
          : /^(Task|Agent)$/.test(name)
            ? 'Task/Agent'
            : aa.isReadOnlyTool(name)
              ? 'read tools'
              : `other:${name}`;

const contexts = new Map();
async function replayFile(entry) {
  const t = tally[entry.kind];
  t.files += 1;
  t.sessions.add(entry.sessionId);
  const rl = createInterface({
    input: createReadStream(entry.file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (line.includes('"tool_result"') && ASK_HOOK.test(line)) {
      const m =
        /([a-z][\w-]*-guard|[a-z][\w-]*)\(([\w-]+)\)[^"]{0,80}?(?:has not authorised|The user has not)/.exec(
          line,
        ) ?? /([a-z][\w-]*guard)\(([\w-]+)\)/.exec(line);
      const key = m ? `${m[1]}(${m[2]})` : 'hook ask';
      t.hookAsks.set(key, (t.hookAsks.get(key) ?? 0) + 1);
    }
    if (!line.includes('"tool_use"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== 'assistant' || !Array.isArray(record.message?.content)) continue;
    for (const block of record.message.content) {
      if (block?.type !== 'tool_use') continue;
      const sessionId = record.sessionId ?? entry.sessionId;
      const ctxKey = `${entry.kind}\0${sessionId}`;
      if (!contexts.has(ctxKey)) contexts.set(ctxKey, buildContext(entry, sessionId, record));
      const base = contexts.get(ctxKey);
      const ctx = {
        ...base,
        cwd: record.cwd ?? base.cwd,
        branch: record.gitBranch && record.gitBranch !== 'HEAD' ? record.gitBranch : base.branch,
      };
      const call = { toolName: block.name, input: block.input, id: block.id, record };
      let decision;
      try {
        decision = await decide(call, ctx);
      } catch (error) {
        decision = {
          outcome: 'error',
          reason: `replay error: ${String(error?.message ?? error).slice(0, 80)}`,
        };
      }
      base.gateSettled = ctx.gateSettled ?? base.gateSettled;
      const oracle = oracleClass(block.name, block.input, {
        cwd: ctx.cwd ?? '',
        root: copyRootOf(ctx.cwd ?? ''),
        branch: ctx.branch,
        group: Boolean(ctx.group),
      });
      t.calls += 1;
      const kind = kindOf(block.name);
      const row = t.byKind.get(kind) ?? {
        calls: 0,
        auto: 0,
        notify: 0,
        deny: 0,
        human: 0,
        'human?': 0,
        deferred: 0,
        error: 0,
      };
      row.calls += 1;
      row[decision.outcome] = (row[decision.outcome] ?? 0) + 1;
      t.byKind.set(kind, row);
      // A D-n does not hold the run, but the human still answers it: routine D-n stays a
      // failure (the owner is bothered later instead of now), critical D-n is the design.
      if (
        decision.outcome === 'human' ||
        decision.outcome === 'deferred' ||
        decision.outcome === 'error'
      ) {
        t.human.push({
          deferred: decision.outcome === 'deferred',
          reason: decision.reason,
          oracle: oracle.cls,
          oracleWhy: oracle.why,
          tool: block.name,
          forwarded: forwardedByCli(block.name, block.input),
          text: summary(block.name, block.input),
          where: `${basename(entry.file)}:${lineNo}`,
          at: record.timestamp,
        });
      }
    }
  }
}

function buildContext(entry, sessionId, record) {
  const cwd = record.cwd;
  let group =
    entry.kind === 'group' ? gp.groupAutoApproveFor(source, keysOf(sessionId)) : undefined;
  if (entry.kind === 'group' && !group) {
    // A copy whose link is gone from state.json (500-link cap): the box rows, edits allowed.
    group = {
      rows: sg.resolveGroupPermissions(
        splitSettings.getSplitDefaults(state).permissions,
        undefined,
      ),
      allowEdits: true,
      parentChatId: '?',
      groupIndex: -1,
    };
  }
  if (group && cwd) {
    if (existsSync(cwd)) facts.copiesLive += 1;
    else facts.copiesGone += 1;
  }
  // The group's own copy as the split record has it (`groupCopyOf`, deferred-bridge.ts).
  const recorded = group
    ? source
        .getSplitPlan(group.parentChatId)
        ?.groups.find((entry) => entry.index === group.groupIndex)?.path || undefined
    : undefined;
  return {
    group,
    cwd,
    branch: record.gitBranch,
    gateSettled: false,
    gateDeferred: new Set(),
    copyPath: recorded,
  };
}

const summary = (tool, input) => {
  if (tool === 'Bash')
    return String(input?.command ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 150);
  if (input?.file_path) return String(input.file_path).slice(0, 150);
  return JSON.stringify(input ?? {}).slice(0, 120);
};

// ------------------------------------------------------------ fixtures

async function runFixtures() {
  const copy = findFixtureCopy();
  if (!copy)
    return {
      copy: undefined,
      danger: [],
      routine: [],
      note: 'no live group copy to anchor fixtures',
    };
  const mainRoot = tests.mainCheckoutOf(copy.cwd) ?? copy.cwd;
  const subst = (s) =>
    s
      .split('@COPY')
      .join(copy.cwd)
      .split('@MAIN')
      .join(mainRoot.split('\\').join('/'))
      .split('@BRANCH')
      .join(copy.branch);
  const group = {
    rows: { ...sg.GROUP_REQUEST_DEFAULTS },
    allowEdits: true,
    parentChatId: 'fixture',
    groupIndex: 0,
  };
  const run = async ([label, spec]) => {
    const call =
      typeof spec === 'string'
        ? { toolName: 'Bash', input: { command: subst(spec) } }
        : { toolName: spec.tool, input: JSON.parse(subst(JSON.stringify(spec.input))) };
    const record = {
      cwd: copy.cwd,
      message: {
        content: [{ type: 'tool_use', id: 'fx', name: call.toolName, input: call.input }],
      },
    };
    const ctx = { group, cwd: copy.cwd, branch: copy.branch, gateSettled: false };
    let decision;
    try {
      decision = await decide({ ...call, id: 'fx', record }, ctx);
    } catch (error) {
      decision = { outcome: 'error', reason: String(error?.message ?? error) };
    }
    const oracle = oracleClass(call.toolName, call.input, {
      cwd: copy.cwd,
      root: copyRootOf(copy.cwd),
      branch: copy.branch,
      group: true,
    });
    return { label, text: summary(call.toolName, call.input), ...decision, oracle: oracle.cls };
  };
  const danger = [];
  for (const fx of DANGER_FIXTURES) danger.push(await run(fx));
  const routine = [];
  for (const fx of ROUTINE_FIXTURES) routine.push(await run(fx));
  return { copy, danger, routine };
}

function findFixtureCopy() {
  for (const ctx of contexts.values()) {
    if (!ctx.group || !ctx.cwd || !existsSync(ctx.cwd)) continue;
    const root = copyRootOf(ctx.cwd);
    if (!existsSync(join(root, '.git'))) continue;
    const branch = ctx.branch && !gc.isProtectedBranch(ctx.branch, 'main') ? ctx.branch : undefined;
    if (branch) return { cwd: root.replace(/^([a-z]):/, (m) => m.toUpperCase()), branch };
  }
  return undefined;
}

// ------------------------------------------------------------ run + report

const started = Date.now();
for (const entry of files) await replayFile(entry);
const fixtures = await runFixtures();

const print = (s = '') => console.log(s);
print(
  `group-asks-replay: route fingerprint ok (${ROUTE_ORDER.length} steps, ${ROUTE_EXITS} exits); ${((Date.now() - started) / 1000).toFixed(0)} s`,
);
print(
  `facts: copies live ${facts.copiesLive} / gone ${facts.copiesGone}; branch from transcript ${facts.branchFromTranscript}; ` +
    `MR state offline ${facts.mrOffline}; kills unreplayed ${facts.killsUnreplayed}; recorded copies added to a worktree list ${facts.recordedCopies}; main sync sole ${facts.syncSole} / worst-case ${facts.syncWorst}; ` +
    `worktree memo ${memoSafe ? 'on' : 'off (source changed)'}; group questions '${groupQuestions}'; chat auto ${chatAuto.enabled}`,
);
const failures = [];
for (const kind of ['group', 'single']) {
  const t = tally[kind];
  if (!t.files) continue;
  print();
  print(
    `${kind === 'group' ? 'GROUPS' : `SINGLE PANEL CHATS (since ${new Date(SINCE).toISOString().slice(0, 10)})`}: ${t.files} files, ${t.sessions.size} sessions, ${t.calls} tool calls`,
  );
  for (const [k, row] of [...t.byKind.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
    const parts = ['auto', 'notify', 'deny', 'human', 'human?', 'deferred', 'error']
      .filter((x) => row[x])
      .map((x) => `${x} ${row[x]}`);
    print(`  ${k.padEnd(28)} ${String(row.calls).padStart(6)}  ${parts.join(', ')}`);
  }
  const byOracle = { routine: 0, critical: 0, grey: 0 };
  for (const h of t.human) byOracle[h.oracle] += 1;
  const deferredCount = t.human.filter((h) => h.deferred).length;
  const deferredRoutine = t.human.filter((h) => h.deferred && h.oracle === 'routine').length;
  print(
    `  human-bound: ${t.human.length} (routine ${byOracle.routine}, critical ${byOracle.critical}, grey ${byOracle.grey})` +
      ` — of them D-n without a wait ${deferredCount} (routine ${deferredRoutine}), a card ${t.human.length - deferredCount}`,
  );
  if (kind === 'group') {
    const fwd = t.human.filter((h) => h.forwarded);
    const fwdRoutine = fwd.filter((h) => h.oracle === 'routine').length;
    print(
      `  of them touched by the group's CLI ask rules (reach the bridge in auto mode, approx.): ${fwd.length} (routine ${fwdRoutine})`,
    );
  }
  if (t.hookAsks.size) {
    print(
      `  CLI hook denials telling the model to ask the human (observed in tool results): ${[...t.hookAsks.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`,
    );
  }
  const reasons = new Map();
  for (const h of t.human) {
    if (!reasons.has(h.reason)) reasons.set(h.reason, []);
    reasons.get(h.reason).push(h);
  }
  print(`  human-bound by reason:`);
  for (const [reason, list] of [...reasons.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const r = list.filter((h) => h.oracle === 'routine').length;
    const rf =
      kind === 'group' ? list.filter((h) => h.oracle === 'routine' && h.forwarded).length : 0;
    print(
      `    [${list.length}] ${reason}${r ? ` — ROUTINE ${r}` : ''}${rf ? ` (${rf} via CLI ask rules)` : ''}`,
    );
    const shown = [...list]
      .sort((a, b) => (a.oracle === 'routine' ? -1 : 0) - (b.oracle === 'routine' ? -1 : 0))
      .slice(0, MAX);
    for (const h of shown)
      print(`        ${h.oracle.padEnd(8)} ${h.tool}: ${h.text}  (${h.where})`);
    if (list.length > shown.length)
      print(`        … ${list.length - shown.length} more (--max, --out)`);
  }
  const routineHuman = t.human.filter((h) => h.oracle === 'routine');
  if (kind === 'group' || flag('strict-singles')) {
    for (const h of routineHuman) {
      const known = kind === 'group' ? knownRow(h) : undefined;
      if (known) accepted.push({ h, known });
      else
        failures.push(
          `${kind} routine call human-bound [${h.reason}] ${h.tool}: ${h.text} (${h.where})`,
        );
    }
  }
}

print();
print(
  `accepted per row (KNOWN_ROWS, each with its reason): ${accepted.length}/${KNOWN_ROWS.length}`,
);
for (const { h, known } of accepted) print(`    ${known.cls.padEnd(15)} ${h.where} — ${known.why}`);
const unseen = KNOWN_ROWS.filter((row) => !accepted.some((a) => a.known === row));
for (const row of unseen)
  print(`    stale entry (row not human-bound in this run, or outside --since): ${row.where}`);

print();
if (!fixtures.copy) print(`fixtures: SKIPPED — ${fixtures.note}`);
else {
  print(
    `fixtures anchored in ${fixtures.copy.cwd} on ${fixtures.copy.branch} (box rows, edits allowed, no MR)`,
  );
  const dangerFail = fixtures.danger.filter(
    (f) => f.outcome === 'auto' || f.outcome === 'notify' || f.outcome === 'error',
  );
  print(
    `  danger fixtures: ${fixtures.danger.length - dangerFail.length}/${fixtures.danger.length} reach the human or are refused`,
  );
  for (const f of fixtures.danger) {
    const bad = dangerFail.includes(f);
    print(
      `    ${bad ? 'FAIL' : 'ok  '} ${f.label.padEnd(12)} ${f.outcome.padEnd(6)} ${f.reason} :: ${f.text}`,
    );
    if (bad) failures.push(`danger fixture ${f.label} resolved ${f.outcome}: ${f.text}`);
  }
  const routineFail = fixtures.routine.filter(
    (f) => f.outcome === 'human' || f.outcome === 'deferred' || f.outcome === 'error',
  );
  print(
    `  routine fixtures: ${fixtures.routine.length - routineFail.length}/${fixtures.routine.length} pass without the human`,
  );
  for (const f of fixtures.routine) {
    const bad = routineFail.includes(f);
    print(
      `    ${bad ? 'FAIL' : 'ok  '} ${f.label.padEnd(20)} ${f.outcome.padEnd(6)} ${f.reason} :: ${f.text}`,
    );
    if (bad) failures.push(`routine fixture ${f.label} human-bound [${f.reason}]: ${f.text}`);
  }
  const oracleOff = [
    ...fixtures.danger.filter((f) => f.oracle === 'routine').map((f) => `danger ${f.label}`),
    ...fixtures.routine
      .filter((f) => f.oracle !== 'routine')
      .map((f) => `routine ${f.label} (${f.oracle})`),
  ];
  if (oracleOff.length)
    print(`  oracle self-check — disagrees with its own fixtures: ${oracleOff.join('; ')}`);
}

if (OUT) {
  writeFileSync(
    OUT,
    JSON.stringify(
      { facts, groups: tally.group.human, singles: tally.single.human, fixtures },
      null,
      2,
    ),
  );
  print(`full list → ${OUT}`);
}
print();
if (failures.length) {
  print(`FAIL ${failures.length}:`);
  for (const f of failures.slice(0, 200)) print(`  ${f}`);
  if (failures.length > 200) print(`  … ${failures.length - 200} more`);
  process.exit(1);
}
print('OK: no routine group call is human-bound; fixtures hold.');
