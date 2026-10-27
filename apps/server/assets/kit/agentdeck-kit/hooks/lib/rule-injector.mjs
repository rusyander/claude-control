// PreToolUse: just-in-time delivery of situational rule blocks.
//
// Some rules only ever apply at one machine-detectable moment: how published text must read
// matters when a commit / MR / issue is about to be written, and the forge/tracker protocol matters
// when a forge or tracker MCP tool is about to be called. Kept in the always-loaded rules
// they cost ~1.1k tokens on EVERY turn of EVERY session — including the majority that never
// commit anything. Delivered here they cost that once, in the session that needs them, at the
// exact moment of use, undiluted.
//
// Deliberately NOT a permission verdict: `additionalContext` (PreToolUse, supported by this
// build) injects text without blocking, so the gate that actually guards these actions
// (git-guard / the user's own approval) keeps working untouched.
//
// Once per session per rule — a stamp file keyed by session id. If the stamp cannot be written
// the rule is injected anyway: a repeat costs tokens, a miss costs a rule.
// Kill-switch: AGENTDECK_KIT_RULE_INJECT=0 (CLAUDE_RULE_INJECT=0 is honoured too).
// The rule texts are the `agentdeck-kit:situational-rules` skill's references: a CLI without hooks loads the same
// files by hand through that skill, so there is one copy of each rule.
//
// Three ways a delivered rule was once silently not delivered, all fixed here:
//   1. A long rule was clipped at a fixed ceiling, so its last section never reached the model. A
//      deliberate payload is now never truncated — the ceiling is derived from what is on disk.
//   2. The stamp outlived compaction: the rule text left the window, the stamp said "sent", and
//      it never came back. `clearRuleStamps` is called from PreCompact, so the next matching
//      action after a compaction re-delivers.
//   3. It fired on the first Edit — after the plan was already decided. Reads (Read/Grep/Glob)
//      of a matching file now trigger it too, i.e. before the plan.
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { codeWrites } from './inline-edit-guard.mjs';
import {
  cliOf,
  logSessionEvent,
  RULES_DIR,
  sessionEvents,
  STATE_DIR,
  stateDir,
} from './kit-paths.mjs';

const RULES = RULES_DIR;
const CACHE = join(STATE_DIR, 'rules');
export const MAX_RULE = 2400; // deliberate payload, not a stray print — see CAP in dispatch.mjs

// Publishing surfaces: git itself, the two forges' CLIs, and the MCP writes that create or
// comment on an issue / MR / page. Read-only MCP calls never trigger it.
const PUBLISH_CMD =
  /\bgit\s+(commit|tag|notes)\b|\bgh\s+(pr|issue|release)\s+(create|edit|comment)|\bglab\s+(mr|issue)\s+(create|update|note)/i;
// Any forge or tracker MCP server: the panel's own bridge (`agentdeck-atlassian`) or a user-attached
// GitLab / GitHub / Jira / Confluence server, whatever its configured name.
export const FORGE_MCP = /^mcp__[^_]*(?:gitlab|github|atlassian|jira|confluence)[^_]*__/i;
const PUBLISH_VERB = /__.*(create|update|add_comment|comment|reply|edit|note|upload)/i;
const isPublishMcp = (tool) => FORGE_MCP.test(tool) && PUBLISH_VERB.test(tool);

// Docker: the moment a second Postgres/Redis is about to be created is the only moment the
// one-shared-instance rule matters, and it is fully machine-detectable — a `run`/`up`/`pull`, or a
// compose file being authored. Destructive verbs are in the trigger too: the rule states what may
// not be deleted unasked, so it must arrive before the delete, not after.
const DOCKER_CMD =
  /\bdocker(-compose)?\s+(compose\s+)?(run|up|create|start|pull|rmi|prune)\b|\bdocker\s+(image|volume|container|system|builder)\s+(rm|prune)\b/i;
const WRITE_TOOL = /^(Edit|Write)$/;
const COMPOSE_FILE = /(^|[\\/])(docker-)?compose[^\\/]*\.ya?ml$/i;
// Task ledger: format, location and lifecycle of TASKS.md arrive when the ledger is read or written; the
// task-ledger Stop gate is what makes it written at all.
const LEDGER_FILE = /(^|[\\/])TASKS\.md$/i;

// Doc placement matters at exactly one moment: a Markdown file is about to be written. Held in the
// always-loaded memory the block cost ~450 tok on every turn of every session, most of which never
// write a doc. Placement itself is still enforced by agent-doc-location / doc-bloat-guard — this
// text is the reasoning behind their verdicts, delivered when a doc is actually being authored.
const DOC_FILE = /\.mdx?$/i;
// A deliverable of a review lane or a subagent (`.agent/tmp/…`: a lane report met the card gate) and a
// note in the OS temp / scratchpad are not documents to place. `.agent/` docs outside tmp (PROGRESS.md,
// notes, a shots README) keep the rule.
const DOC_SCRATCH = /[\\/]\.agent[\\/]tmp[\\/]/i;
const TEMP_ROOTS = (() => {
  const roots = new Set();
  for (const r of [tmpdir(), process.env.TEMP, process.env.TMP]) {
    if (!r) continue;
    roots.add(r);
    try {
      roots.add(realpathSync.native(r)); // Windows hands out the 8.3 form and the long one alike
    } catch {
      /* a TEMP that does not exist holds no file */
    }
  }
  return [...roots].map((r) => `${r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}/`);
})();
function scratchDoc(p) {
  if (DOC_SCRATCH.test(p)) return true;
  const n = p.replace(/\\/g, '/').toLowerCase();
  return TEMP_ROOTS.some((r) => n.startsWith(r));
}

// Before/after shots: the procedure is only ever needed once a UI file is actually in hand, and it
// must arrive BEFORE the first edit — hence reads count as the trigger, the same fix as incident 3.
// The invariant itself stays in CLAUDE.md; this delivers the steps.
const UI_SOURCE = /\.(tsx?|jsx?|vue|svelte|css|scss|less)$/i;

// Probe and scratch files are not the product's UI (measured: scratchpad .js probes pulled this rule).
const SCRATCH_PATH = /[\\/](?:Temp|tmp|scratchpad)[\\/]|[\\/]\.agent[\\/]/i;

// Hook authoring: the contract matters at exactly one moment — a hook script or its wiring is being
// written. The dispatcher already enforces what a hook may cost; this delivers what its author has to
// hold to, including the one failure mode hooks have, which is dying without a sound.
// `hooks/hooks.json` is a plugin's own hook manifest — the wiring lives elsewhere, the contract is
// identical. A repo's `src/hooks/useThing.mjs` is React and must stay out of it, hence the manifest
// name rather than the folder.
const HOOK_SOURCE =
  /[\\/]\.claude[\\/](?:hooks[\\/].*\.(?:mjs|cjs|js)|settings(?:\.local)?\.json)$|[\\/]hooks[\\/]hooks\.json$/i;

// Config work: what auto-loaded text, a skill listing and an attached MCP server cost, and how each is
// changed without paying twice. Kept out of the always-loaded rules — it was re-billed on every turn of
// every session to serve the few that edit config. The moment is an edit of the auto-loaded layer
// (any CLAUDE.md / AGENTS.md, a skill, agent, command or rule) or of MCP/plugin config.
const CONFIG_SOURCE =
  /(?:^|[\\/])(?:CLAUDE(?:\.local)?|AGENTS|SKILL)\.md$|[\\/]\.claude[\\/](?:skills|agents|commands|rules|hooks[\\/]rules)[\\/]|(?:^|[\\/])\.mcp\.json$|[\\/]\.claude(?:\.json|[\\/]settings(?:\.local)?\.json)$/i;

// PDF layout: the two moments that matter are authoring the page CSS and rendering the file. The
// render trigger is the load-bearing one — it arrives before the verify step the rule demands.
const PDF_CMD = /--print-to-pdf|\b(pandoc|weasyprint|wkhtmltopdf|prince)\b|\bpuppeteer\b|\.pdf\b/i;
const PDF_MARKUP = /@page\b|page-break|break-inside|\bprint\s*\{/i;
const PDF_SOURCE = /\.(html?|css|scss|typ|tex)$/i;

// Local model: the rule is about HIS machine's memory, so it must arrive before anything can load a
// model — `ollama run/serve/pull`, a llama.cpp server, or a request straight at the daemon's port.
// `ollama ps`/`list`/`stop` are in the trigger on purpose: the shutdown order is the half that gets
// got wrong (a leaked runner once froze a desktop for ~15 minutes).
const LOCAL_MODEL_CMD =
  /\bollama\b|\bllama-server\b|\bllama\.cpp\b|\blmstudio\b|:11434\b|:1234\/v1\b/i;

// Git write protocol: mutating verbs only. `git status`/`log`/`diff` are free and must not drag a
// rule block in, but every gate the protocol describes (git-guard, Door C, the reply requirement)
// applies from the moment a mutating verb appears — including the ones git-guard lets through.
const GIT_WRITE_CMD =
  /\bgit\s+(commit|push|pull|merge(?!-(?:base|tree|file)\b)|rebase|reset|revert|cherry-pick|tag|stash|branch|checkout\s+-b|switch\s+-c|clean)\b|\b(gh|glab)\s+\w+\s+(create|edit|update|merge|close|comment|note)\b/i;

// Verification depth: the invariant is in CLAUDE.md, the mechanics are only ever needed at two
// machine-detectable moments — a test file is in hand, or a check is about to run. Reads count for
// the same reason as incident 3: the substitution boundary is decided while the test is being
// planned, not after it is written. `npm run check`/lint gates are deliberately NOT triggers — they
// say nothing about how deep a check goes.
const TEST_FILE =
  /[._-](test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|[\\/])(test_[^\\/]+|conftest)\.py$|(^|[\\/])(tests?|__tests__|e2e)[\\/]/i;
const TEST_TOOL = /^(Edit|Write|NotebookEdit|Read)$/;
// A scratch script is not a test of the product: a Write of `.agent/tmp/resolve-spec.mjs` (an API-spec
// merge script) matched `-spec.mjs` and pulled 7k of this rule. Scratch = `.agent/tmp`, any `tmp/` or
// `scratchpad/` folder. The OS temp root itself is not one: throwaway repos with real test files live
// right under it (test fixtures), the scratchpad is a folder below it.
function scratchTest(p) {
  if (DOC_SCRATCH.test(p)) return true;
  let n = p.replace(/\\/g, '/');
  const root = TEMP_ROOTS.find((r) => n.toLowerCase().startsWith(r));
  if (root) n = n.slice(root.length);
  return /(?:^|\/)(?:tmp|scratchpad)\//i.test(n);
}
// The second alternative is the ad-hoc parity script: a design comparison run as a plain
// `node parity-check.mjs` matched nothing, and the rule about how deep a check goes stayed silent
// through the exact failure it describes.
// Third alternative: a runner under `tests/` — `node hooks/tests/all.mjs`, `python
// tests/test_api.py` — is a check about to run.
// Fourth alternative: the two tools that DECIDE the depth — the tier and the red-on-revert proof —
// are run before any test, and the ladder they print is explained by this rule alone.
const VERIFY_CMD =
  /\b(pytest|vitest|jest|mocha|playwright|go\s+test|npm\s+(run\s+)?test|check_frontend_tests\.mjs|risk-tier\.mjs|mustfail\.mjs)\b|\b(node|bun|deno|tsx)\s+\S*[._-](test|spec)\.[cm]?[jt]s\b|\b(node|bun|deno|tsx|python3?)\s+(\S*[\\/])?(tests?|__tests__)[\\/]\S+\.(mjs|cjs|js|ts|py)\b|\b\S*(check|verif|parity|audit|scan|compare)\S*\.(mjs|cjs|js|ts|py)\b/i;

// Review depth: the moment a change is first LOOKED at, not the moment a comment is written — the
// baseline header, the entry-point split and the description-as-claims pass all have to be decided
// before the first finding. Hence the diff reads trigger it, and the publishing calls trigger it
// again for the sessions that only publish (a review carried over from a compaction).
// Added after three separate failures: a duplicate of a human review posted forty minutes late, a
// head that moved under the review, and a red job diagnosed statically without reading its log.
const REVIEW_MCP =
  /^mcp__[^_]*(?:gitlab|github)[^_]*__(get_merge_request$|get_merge_request_diffs|list_merge_request_diffs|list_merge_request_changed_files|get_merge_request_file_diff|get_branch_diffs|mr_discussions|create_merge_request_thread|create_draft_note|create_merge_request_note|create_merge_request_discussion_note|bulk_publish_draft_notes|get_pull_request|get_pull_request_diff|get_pull_request_files|create_pull_request_review|add_pull_request_review_comment)/i;
// CLI equivalents: `glab mr diff` / `gh pr diff` are the same first look at a change.
const REVIEW_FORGE_CMD = /\b(glab\s+mr|gh\s+pr)\s+(diff|view|checkout)\b/i;
// Three-dot: `git diff a...b` is a review of what a branch changed. Two-dot is ordinary work.
// Second alternative: the working tree is one of the four scopes `deep-review` names, and
// it is read with a BARE `git diff` — no three dots anywhere. A PATHSPEC is what separates the two:
// `git diff src/x.tsx` is me looking at my own edit, `git diff` / `--cached` / `--staged` is the whole
// tree, which is the review posture. Flags are allowed in front, a path is not. `--stat` /
// `--name-only` / `--name-status` show no code: they SIZE a change (`git diff --stat | tail` pulled the
// whole rule in) and stay out — the rule arrives at the first real diff read.
const REVIEW_CMD =
  /\bgit\s+diff\b[^|;]*\.\.\.|(^|[;&|]\s*)git\s+diff(\s+(--cached|--staged|HEAD))*\s*($|[;&|])/i;

// Live check: a browser is about to drive the product, or a stand is coming up to be driven. The
// four variations are chosen while the script is being written, so writing one counts as the trigger
// alongside running it.
// `e2e/...` is matched at a word start too, not only after a slash: the scripts are run as
// `node e2e/acceptance.mjs` from the repo root, which has a space in front of it.
// Fourth to sixth alternatives: the stand is reached by more roads than
// a browser — an API call with curl against a local/dev host or with a method/body/header (a bare
// download stays out), a server coming up (node server.js, uvicorn, go run, vite…), a port-forward
// into the cluster. Each of those is the moment the four variations get chosen or skipped.
const LIVE_CMD =
  /\b(playwright|puppeteer|frontend_dev\.mjs|local_ip_up\.sh|local_cp_up\.sh)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b|(^|[\s\\/"'])e2e[\\/]\S+\.(mjs|cjs|js|ts)\b|--headed\b|\bcurl\b[^|;]*?(localhost|127\.0\.0\.1|0\.0\.0\.0|\.local\b|:\d{4,5}\b|\s-X\s|\s-d\s|--data|\s-H\s|--header)|\bport-forward\b|\b(uvicorn|gunicorn|nodemon|vite|next\s+dev|astro\s+dev|flask\s+run|manage\.py\s+runserver|go\s+run)\b|\b(node|bun|deno|tsx)\s+\S*serv(er|e)\S*\.[cm]?[jt]s\b/i;
const LIVE_MARKUP = /\b(page\.goto|chromium\.launch|browser\.newContext|page\.route|expectFail)\b/;
const LIVE_SOURCE = /\.(mjs|cjs|js|ts)$/i;

// A file read or written in one of these tools is a moment for the UI rule (reads count: incident 3).
const UI_TOOL = /^(Edit|Write|NotebookEdit|Read|Grep|Glob)$/;

// Delivered whole, never clipped at MAX_RULE: each is a closed procedure whose last section carries
// the part that actually gets got wrong, and half a closed list reads as the complete one.
export const BIG_RULES = new Set([
  'docker-shared',
  'published-text',
  'verification-depth',
  'review-depth',
  'live-check',
  'forge-protocol',
]);

const sizeOf = (name) => {
  try {
    return statSync(join(RULES, `${name}.md`)).size;
  } catch {
    return 0;
  }
};
// Split group (the panel sets AGENTDECK_SPLIT_CHILD=1), phase G.3: a group compacts every ~15 min
// and every compaction re-sent each rule whole — in measured worktree sessions the re-sends were
// twice the first sends, and the group then Read the source file anyway. There a RE-delivery (the
// rule already reached this session once) is a card ≤ CARD_MAX: title, the file path with a Read
// window per section, the lead clipped to fit. The first delivery stays whole (quality on first
// contact); a human session is untouched. The `.sent` mark outlives compaction on purpose.
export const CARD_MAX = 1000;
const splitChild = () => process.env.AGENTDECK_SPLIT_CHILD === '1';
// Every stage of a group is a NEW session, so the `.sent` mark above never carried — one measured group
// got verification-depth whole 10×7.1k, live-check 8×4.2k, review-depth 3×6.4k (5.22M cache_read). A
// rule ≥ COPY_CARD_MIN that reached ANY session of the same copy (the git worktree root of cwd) arrives
// as the card in later stages; shorter rules stay whole per session (the card would save little and a
// new session holds none of the earlier text).
export const COPY_CARD_MIN = 4000;
/** `copy-<hash>` of the git root above cwd (a worktree has a `.git` file), or null outside a repo. */
export function copyKey(cwd) {
  let dir = String(cwd ?? '');
  if (!dir) return null;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, '.git'))) {
      const norm = dir.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
      return `copy-${createHash('sha1').update(norm).digest('hex').slice(0, 12)}`;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Ceiling the dispatcher must allow so the largest deliberate payload is not clipped on its way out. */
export const MAX_RULE_CEILING = Math.max(MAX_RULE * 2, ...[...BIG_RULES].map(sizeOf)) + 512;
// What one call's rules may total before the next one is deferred: the ceiling less its 512 of slack,
// which the dispatcher spends on the sieve note beside the rules and on `<kit>` resolving to the
// real root. The biggest rule always fits alone.
export const PAYLOAD_MAX = MAX_RULE_CEILING - 512;

// A trigger is a MOMENT, not a word. The command-text triggers below matched file NAMES
// anywhere in a Bash line, so `cat hooks/verify-hard-hint.mjs`, `wc -c tools/skills-audit.mjs` and
// `grep … e2e/lib.mjs` each pulled in a 1.4k-token rule about running a check — while nothing ran.
// Only the segments that EXECUTE something are looked at: the line is split on shell separators
// (masked inside quotes first, or a regex alternation splits a grep in two), wrappers and env
// assignments are stepped over, and a segment led by a read-only tool is dropped.
const READ_ONLY =
  /^(cat|bat|head|tail|less|more|grep|egrep|fgrep|rg|ag|sed|awk|ls|dir|find|fd|wc|stat|file|echo|printf|sort|uniq|cut|tr|diff|cmp|tree|which|where|type|test|\[|\[\[|read|cd|pushd|popd|pwd|export|set|true|false|basename|dirname|realpath|readlink|du|df|jq|yq|xxd|od|strings|tasklist|cp|mv|mkdir|touch|Get-Content|Get-ChildItem|Select-String|gc|gci|sls)$/i;
const WRAPPER = /^(time|sudo|env|command|exec|nohup|\w+=\S*)$/;
// Shell keywords execute nothing themselves: `for f in a.mjs hooks-audit.mjs;
// do cat "$f"; done` and `if [ -f x ]; then wc -c skills-audit.mjs; fi` both pulled the verification
// rule in — `for` / `then` were kept as the "command", and the file names behind them looked like a
// run. A `for … in <list>` / `case … in` segment is pure data and is dropped whole; a keyword that
// opens a body (`if`, `then`, `do`, `while`, …) is stepped over like a wrapper so the real command is
// judged; a closing keyword on its own is nothing.
const LIST_KEYWORD = /^(for|select|case)$/;
const OPEN_KEYWORD = /^(if|then|elif|else|do|while|until|!|\{|\()$/;
const CLOSE_KEYWORD = /^(done|fi|esac|\}|\))$/;
// A heredoc body is DATA unless an interpreter reads it: `cat >> notes.md <<EOF … pnpm test … EOF` and a
// commit message carrying "vitest" ran nothing, yet pulled the verification and live-check rules in —
// 21% of all injected rule text in a measured week (measured). `node - <<EOF` keeps its body.
const HEREDOC = /(^|\n)([^\n]*?)<<-?\s*['"]?(\w+)['"]?([^\n]*)\n[\s\S]*?\n\s*\3(?=\s|$)/g;
const INTERPRETER =
  /^(?:node|nodejs|deno|bun|tsx|python3?|py|bash|sh|zsh|pwsh|powershell|ruby|perl|php|psql|sqlite3|mysql)(?:\.exe)?$/i;
const commandWord = (text) => {
  const words = text.trim().split(/\s+/);
  while (words.length && WRAPPER.test(words[0])) words.shift();
  return words;
};
// Code heredocs run too: piped into an interpreter (`cat <<EOF | node`), or written to a file the same
// command then runs (`cat > x.mjs <<EOF … EOF; node x.mjs`) — dropping those lost 134 true fires a week.
function runsLater(before, after, rest) {
  const pipe = /\|\s*([^|;&]+)/.exec(after);
  if (pipe && INTERPRETER.test(commandWord(pipe[1])[0] ?? '')) return true;
  const file = />{1,2}\s*["']?([^\s"';&|]+)/.exec(before)?.[1];
  if (!file) return false;
  const base = file.split(/[\\/]/).pop();
  return rest.split(/&&|\|\||[;\n]/).some((seg) => {
    const words = commandWord(seg);
    return (
      INTERPRETER.test(words[0] ?? '') &&
      words.slice(1).some((w) => w.replace(/["']/g, '').endsWith(base))
    );
  });
}
export function dropDataHeredocs(cmd) {
  return cmd.replace(HEREDOC, (whole, lead, before, _tag, after, offset) => {
    const words = commandWord(before.split(/[|;&]/).pop());
    if (INTERPRETER.test(words[0] ?? '')) return whole;
    if (runsLater(before, after, cmd.slice(offset + whole.length))) return whole;
    return `${lead}${before} ${after}`;
  });
}

// A quoted phrase handed to a non-interpreter is data: `node inspect.mjs calls.jsonl "npx vitest run …"`
// pulled the verification rule in. Code after -c/-e stays; a quoted single word (a URL, a path) stays.
const QUOTED = /(\s-(?:c|e|-eval|Command)\s+)?("(?:[^"\\]|\\.)*"|'[^']*')/g;
const keepQuoted = (_m, flag, q) =>
  flag || !/\s/.test(q.slice(1, -1)) ? `${flag ?? ''}${q.replace(/[|;&\n]/g, ' ')}` : ' ';

export function runnable(cmd) {
  return dropDataHeredocs(String(cmd ?? ''))
    .replace(QUOTED, keepQuoted)
    .split(/&&|\|\||[;|\n]/)
    .map((seg) => seg.trim())
    .filter((seg) => {
      if (!seg) return false;
      const words = seg.split(/\s+/);
      if (LIST_KEYWORD.test(words[0])) return false;
      while (words.length && (WRAPPER.test(words[0]) || OPEN_KEYWORD.test(words[0]))) words.shift();
      return words.length && !READ_ONLY.test(words[0]) && !CLOSE_KEYWORD.test(words[0]);
    })
    .join(' ; ');
}

/** @returns {string|null} the rule text to inject, or null. */
export default function ruleInjector(input, budget = PAYLOAD_MAX) {
  if (injectOff()) return null;
  const session = String(input?.session_id ?? 'x').slice(0, 12);
  const wanted = wantedOf(input);
  if (!wanted.length) return null;

  const out = [];
  let used = 0;
  const group = splitChild();
  const copy = group ? copyKey(input?.cwd) : null;
  const gate = group ? readGate(session) : {};
  // A gated rule's whole file — this call is the one cardGate denies, so the text must ride with it; a
  // method rule's (METHOD_RULES) rides with a call cardGate lets through
  // (see cardGate). Null = not gated here, already Read, unreadable, a parallel sibling took it, or it
  // does not fit whole (then the card and the Read instruction stay). `as` = the call the rule is judged
  // on: this one, or the Edit of a file a script of this call writes (see wantedOf).
  const fullFor = (rule, file, as = input) => {
    if (!group || !feeds(rule, as)) return null;
    const full = fileText(file);
    if (!full || used + full.length > budget) return null;
    if (readInTranscript(input?.transcript_path, file, needOf(file, as)) !== false) return null;
    if (!claimFeed(session, rule)) {
      fed.set(`${session}:${rule}`, { file, sibling: true });
      return null;
    }
    fed.set(`${session}:${rule}`, { file });
    return full;
  };
  // A parallel call of a batch whose earlier call was already refused for the rule (see batchSibling):
  // a one-line note instead of the text, and no deny from cardGate.
  const siblings = new Set();
  if (group)
    for (const { rule, via = input } of wanted)
      if (gates(rule, via) && batchSibling(session, rule, input)) {
        siblings.add(rule);
        out.push(siblingNote(rule));
        used += out[out.length - 1].length + 2;
      }
  // Pass 1 — a card an earlier lookup armed and this call is gated on.
  const fedNow = new Set();
  for (const { rule, via } of wanted) {
    if (!gate[rule] || siblings.has(rule)) continue;
    const full = fullFor(rule, gate[rule].file, via);
    if (!full) continue;
    out.push(full);
    used += full.length + 2;
    fedNow.add(rule);
    // After a compaction the stamp is gone while the gate survives: written here, or Pass 2 below sent
    // the card again beside the text (full + card of one rule in the same millisecond).
    alreadySent(session, rule);
    logDelivery(session, rule, full.length, { feed: true });
  }
  // Pass 2 — the rules due now; a card this call is gated on goes first, so its whole text is never the
  // one that finds no room. One that does not fit beside the others is deferred, never clipped: the
  // dispatcher cuts the joined block at MAX_RULE_CEILING, and half a rule reads as the complete one.
  const due = wanted
    .filter(
      ({ rule }) => !fedNow.has(rule) && !siblings.has(rule) && !existsSync(stampOf(session, rule)),
    )
    .map(({ rule, text, via = input }) => {
      const body = text ? text() : read(rule);
      const big = Boolean(body) && body.length >= COPY_CARD_MIN;
      const inSession = group && existsSync(sentOf(session, rule));
      const inCopy = !inSession && big && copy && existsSync(sentOf(copy, rule));
      return {
        rule,
        via,
        body,
        big,
        inSession,
        inCopy,
        first: (inSession || inCopy) && gates(rule, via),
      };
    })
    .sort((a, b) => Number(b.first) - Number(a.first));
  for (const { rule, via, big, inSession, inCopy, body: text } of due) {
    let body = text;
    if (!body) continue;
    const path = join(RULES, `${rule}.md`);
    let card = null;
    if (inSession || inCopy) {
      // Not deferred-then-lost: no stamp is written, so the next test-file Edit brings the card.
      if (rule === 'verification-depth' && checkRun(via)) continue;
      card = cardOf(body, path, rule, inCopy ? 'copy' : 'session');
      body = fullFor(rule, path, via) ?? card;
    }
    // Deferred, not dropped: no stamp is written, so the next matching call brings it.
    if (out.length && used + body.length > budget) continue;
    if (alreadySent(session, rule)) continue;
    out.push(body);
    used += body.length + 2;
    logDelivery(session, rule, body.length, card && body !== card ? { feed: true } : null);
    if (group) markSent(session, rule);
    if (big && copy) markSent(copy, rule);
    if (card) armCard(session, rule, path, card);
  }
  return out.length ? out.join('\n\n') : null;
}

const injectOff = () =>
  process.env.AGENTDECK_KIT_RULE_INJECT === '0' || process.env.CLAUDE_RULE_INJECT === '0';

const SHELL_TOOL = /^(Bash|PowerShell)$/;
/**
 * The rules this call is a trigger for, in delivery order (`{ rule, text?, via? }`). A shell call that
 * writes files through code (a scratch script run by path, an inline edit let through by its repeat) is
 * also every Edit of those files: their rules are its rules, `via` = that Edit, so the card gate and its
 * section need judge them as the Edit (a split group made 17 UI edits that way, package rules unread).
 */
function wantedOf(input) {
  const wanted = ownWanted(input);
  if (!SHELL_TOOL.test(String(input?.tool_name ?? ''))) return wanted;
  let files = [];
  try {
    files = codeWrites(String(input?.tool_input?.command ?? ''), input?.cwd);
  } catch {
    /* an unparsable command keeps its own triggers */
  }
  for (const file of files) {
    const via = { ...input, tool_name: 'Edit', tool_input: { file_path: file } };
    for (const w of ownWanted(via)) {
      const had = wanted.find((x) => x.rule === w.rule);
      if (!had) wanted.push({ ...w, via });
      else had.via ??= via;
    }
  }
  return wanted;
}

function ownWanted(input) {
  const tool = String(input?.tool_name ?? '');
  const cmd = String(input?.tool_input?.command ?? '');
  const run = runnable(cmd); // what the line EXECUTES — see runnable()
  const wanted = [];
  if (PUBLISH_CMD.test(cmd) || isPublishMcp(tool)) wanted.push({ rule: 'published-text' });
  if (FORGE_MCP.test(tool)) wanted.push({ rule: 'forge-protocol' });
  const editPath = String(input?.tool_input?.file_path ?? '');
  if (DOCKER_CMD.test(run) || (WRITE_TOOL.test(tool) && COMPOSE_FILE.test(editPath)))
    wanted.push({ rule: 'docker-shared' });
  if (
    WRITE_TOOL.test(tool) &&
    DOC_FILE.test(editPath) &&
    !scratchDoc(editPath) &&
    !siteContent(input)
  )
    wanted.push({ rule: 'doc-classification' });
  if ((WRITE_TOOL.test(tool) || tool === 'Read') && LEDGER_FILE.test(editPath))
    wanted.push({ rule: 'task-ledger' });
  if (GIT_WRITE_CMD.test(cmd)) wanted.push({ rule: 'git-writes' });
  if (LOCAL_MODEL_CMD.test(run)) wanted.push({ rule: 'local-models' });
  if (WRITE_TOOL.test(tool) && HOOK_SOURCE.test(editPath)) wanted.push({ rule: 'hook-authoring' });
  if (WRITE_TOOL.test(tool) && CONFIG_SOURCE.test(editPath)) wanted.push({ rule: 'config-work' });
  if (UI_TOOL.test(tool) && UI_SOURCE.test(editPath) && !SCRATCH_PATH.test(editPath))
    wanted.push({ rule: 'visible-fix-shots' });
  if (
    VERIFY_CMD.test(run) ||
    (TEST_TOOL.test(tool) && TEST_FILE.test(editPath) && !scratchTest(editPath))
  )
    wanted.push({ rule: 'verification-depth' });
  if (REVIEW_MCP.test(tool) || REVIEW_CMD.test(cmd) || REVIEW_FORGE_CMD.test(run))
    wanted.push({ rule: 'review-depth' });
  const written = String(input?.tool_input?.content ?? input?.tool_input?.new_string ?? '');
  if (
    LIVE_CMD.test(run) ||
    (WRITE_TOOL.test(tool) && LIVE_SOURCE.test(editPath) && LIVE_MARKUP.test(written))
  )
    wanted.push({ rule: 'live-check' });
  if (
    PDF_CMD.test(run) ||
    (WRITE_TOOL.test(tool) && PDF_SOURCE.test(editPath) && PDF_MARKUP.test(written))
  )
    wanted.push({ rule: 'pdf-layout' });
  return wanted;
}

// Card gate (owner, 25.10.2026: the token cuts must not lower quality). A card saves tokens only when
// the agent skips the Read, and skipping it IS the quality loss. So a split-group session that got a
// card for rule R has every call that triggers R denied until it has Read R's file (a whole section of
// the edited file's kind, see needOf; after
// the last compaction for a re-send card) — the first such call is the one the card came with. The
// transcript is the evidence. Fail-open: an unreadable rule file or no transcript allows. Not a
// repeat-escape: a bare repeat stays denied until the rule reached the model.
// Deny → Read → retry cost two turns per card (~175k at a 115k context). Now the deny itself carries the
// whole file in additionalContext (the reason is capped at CAP.pre, the context rides at
// MAX_RULE_CEILING; a deny's context reaches the model whole) and that deny lifts the gate, so the repeat
// passes. A file that does not fit beside the call's other rules keeps the Read instruction; the next
// gated call, with its other rules stamped, brings it whole.
const gateOf = (session) => join(CACHE, `rule-cards-${session}.json`);
function readGate(session) {
  try {
    return JSON.parse(readFileSync(gateOf(session), 'utf8')) ?? {};
  } catch {
    return {};
  }
}
function writeGate(session, gate) {
  try {
    if (Object.keys(gate).length) {
      stateDir('rules');
      writeFileSync(gateOf(session), JSON.stringify(gate));
    } else if (existsSync(gateOf(session))) unlinkSync(gateOf(session));
  } catch {
    /* a lost gate costs one unread card, never the call */
  }
}
function armCard(session, rule, file, card) {
  const gate = readGate(session);
  gate[rule] = { file, head: card.split('\n').slice(0, 2).join('\n') };
  writeGate(session, gate);
}
// The last four path segments: `C:\Users\RUSYAN~1\…` and `C:/Users/<name>/…` spell one file.
const pathTail = (p) =>
  String(p ?? '')
    .replace(/\\/g, '/')
    .toLowerCase()
    .split('/')
    .filter(Boolean)
    .slice(-4)
    .join('/');

// The lines (1-based, inclusive) a read of the file put in front of the model: a Read's offset/limit
// window, `sed -n 'a,bp'`, `head -n N`, a whole `cat`. null = not this file, or a window it cannot tell
// (`tail` counts from an end it does not know).
const WHOLE = [1, Number.MAX_SAFE_INTEGER];
function opened(block, want) {
  if (block.name === 'Read') {
    if (pathTail(block.input?.file_path) !== want) return null;
    const from = Math.max(1, Number(block.input?.offset) || 1);
    return [from, from + (Number(block.input?.limit) || 2000) - 1];
  }
  if (block.name !== 'Bash') return null;
  const cmd = String(block.input?.command ?? '')
    .replace(/\\+/g, '/')
    .toLowerCase();
  if (!/^\s*(cat|head|tail|sed\s+-n|type|less)\b/.test(cmd)) return null;
  if (!cmd.includes(want.split('/').slice(-2).join('/'))) return null;
  const sed = /^\s*sed\s+-n\s+['"]?(\d+)\s*,\s*(\d+)\s*p/.exec(cmd);
  if (sed) return [Number(sed[1]), Number(sed[2])];
  const head = /^\s*head\s+(?:-n\s*|-)(\d+)/.exec(cmd);
  if (head) return [1, Number(head[1])];
  return /^\s*(cat|type|less)\b/.test(cmd) ? WHOLE : null;
}

// Edited-file kind → the words that name its section in a rule's `## ` headings (g5 25.10: a 6-line Read
// of a frontend rule's i18n section lifted the card for six `.mdx` prose Edits it says nothing about).
// A section also belongs to a kind when its body names the file's extension (`.mdx`, `_test.go`).
// A node script outside a package's source tree — `scripts/**`, `tools/**`, a `.mjs`/`.cjs` not under
// `src/` (two Edits of a package's `scripts/*.mjs` were once denied and the model read three sections,
// 8.8k chars, where one lifts the gate: the `.js` row's import|state|types words name React-only
// sections). Its section is the code one alone.
const NODE_SCRIPT = {
  test(p) {
    const f = String(p).split('\\').join('/');
    return (
      /\.[cm]?[jt]s$/i.test(f) &&
      !/(^|\/)src\//i.test(f) &&
      (/(^|\/)(scripts|tools)\//i.test(f) || /\.[cm]js$/i.test(f))
    );
  },
};
const SECTION_KINDS = [
  { path: TEST_FILE, words: /\btests?\b|\bspec|mock|fixture|substitut|proxy|proof|check/i },
  { path: /\.(md|mdx|rst|adoc)$/i, words: /\bdocs?\b|document|markdown|prose|readme|wording/i },
  { path: /\.(css|scss|sass|less)$/i, words: /styl|css|theme|colou?r|spacing/i },
  {
    path: /\.(tsx|jsx|vue|svelte)$/i,
    words:
      /component|\bui\b|react|modal|form|table|layout|import|state|styl|theme|i18n|toast|code/i,
  },
  // `script`: a section that merely names the extension (a generated `.cjs` config) is not about the script.
  { path: NODE_SCRIPT, words: /\bcode\b/i, script: true },
  {
    path: { test: (p) => /\.[cm]?[jt]s$/i.test(p) && !NODE_SCRIPT.test(p) },
    words: /\bcode\b|module|import|state|types?\b/i,
  },
  { path: /\.go$/i, words: /\bgo\b|golang|backend|\bcode\b/i },
  { path: /\.py$/i, words: /python|backend|\bcode\b/i },
  { path: /\.(json|ya?ml|toml|ini)$/i, words: /config|settings|schema/i },
];
/**
 * The line ranges of `file` one of which a read must cover whole to lift its card: the sections mapped
 * to the edited file's kind; no section of that kind → the whole file (the section covering the work is
 * then the rule itself); a call with no edited file, or a kind no table row names → any one whole section.
 * A fragment of a section never lifts.
 */
export function needOf(file, input) {
  let text;
  try {
    text = readFileSync(file, 'utf8').replace(/\s+$/, '');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const starts = lines.flatMap((l, i) => (l.startsWith('## ') ? [i] : []));
  const whole = [[1, lines.length]];
  if (!starts.length) return whole;
  const sections = starts.map((s, k) => ({
    range: [s + 1, starts[k + 1] ?? lines.length],
    head: lines[s],
    body: lines.slice(s + 1, starts[k + 1] ?? lines.length).join('\n'),
  }));
  const edit = String(input?.tool_input?.file_path ?? input?.tool_input?.notebook_path ?? '');
  const kinds = edit ? SECTION_KINDS.filter((k) => k.path.test(edit)) : [];
  if (!kinds.length) return sections.map((s) => s.range);
  const script = kinds.some((k) => k.script);
  const ext = script
    ? null
    : /([._-](?:test|spec)\.[cm]?[jt]sx?|_test\.go|\.[a-z0-9]+)$/i.exec(edit)?.[1]?.toLowerCase();
  // Best match first (the deny names the first four, and its first is the one to read): a heading of the
  // kind outranks a body that only names the extension; file order breaks ties.
  const score = (s) =>
    (kinds.some((k) => k.words.test(s.head)) ? 2 : 0) +
    (ext && s.body.toLowerCase().includes(ext) ? 1 : 0);
  const mapped = sections.filter((s) => score(s) > 0).sort((a, b) => score(b) - score(a));
  return mapped.length ? mapped.map((s) => s.range) : whole;
}

/**
 * Did this session read `file` after its last compaction — any window, or (with `need`) windows whose
 * union covers one of the `need` ranges whole? null = no transcript to tell.
 */
export function readInTranscript(transcript, file, need = null) {
  let text;
  try {
    text = readFileSync(String(transcript ?? ''), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  let from = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('"compact_boundary"')) {
      from = i + 1;
      break;
    }
  }
  const want = pathTail(file);
  // A Read the tool refused delivered nothing («exceeds maximum allowed tokens» on a whole rule file
  // once counted as reading it): its call never covers a window.
  const failed = new Set();
  for (let i = from; i < lines.length; i++) {
    if (!lines[i].includes('"is_error":true')) continue;
    try {
      for (const b of JSON.parse(lines[i])?.message?.content ?? [])
        if (b?.type === 'tool_result' && b.is_error && b.tool_use_id) failed.add(b.tool_use_id);
    } catch {
      /* a torn line names no failure */
    }
  }
  const windows = [];
  for (let i = from; i < lines.length; i++) {
    if (!lines[i].includes('"tool_use"')) continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const blocks = Array.isArray(rec?.message?.content) ? rec.message.content : [];
    for (const b of blocks) {
      const w = b?.type === 'tool_use' && !failed.has(b.id) ? opened(b, want) : null;
      if (!w) continue;
      if (!need) return true;
      windows.push(w);
      if (need.some((r) => covered(windows, r))) return true;
    }
  }
  return false;
}
// Read refuses a window over 10,000 tokens, `limit` or not (a deny once named offset=1 limit=103 of a
// 27,162-byte rule = 10,961 tokens → «exceeds maximum allowed tokens», a lost turn, then `allow_large`
// put 27k in the window). 16,000 bytes ≈ 6.5k tokens at that file's 2.48 bytes/token — room for denser
// text and Read's line-number prefixes. A window over it is named in parts.
export const READ_WINDOW_MAX = 16_000;
const SPLIT_NOTE = " ('+' joins the parts of one window too big for one Read: Read every part)";
/** `offset=a limit=n` for lines a..b (1-based) of `lines`; over READ_WINDOW_MAX → parts joined by ` + `. */
function windowOf(lines, a, b) {
  const parts = [];
  let from = a;
  let bytes = 0;
  for (let i = a; i <= b && i <= lines.length; i++) {
    const n = Buffer.byteLength(lines[i - 1], 'utf8') + 1;
    if (bytes + n > READ_WINDOW_MAX && i > from) {
      parts.push([from, i - 1]);
      from = i;
      bytes = 0;
    }
    bytes += n;
  }
  parts.push([from, b]);
  return parts.map(([x, y]) => `offset=${x} limit=${y - x + 1}`).join(' + ');
}
function linesOf(file) {
  try {
    return readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}
// The Read windows a card deny names: the ranges `needOf` accepts, the first four, each Read-sized.
function windowsOf(need, file) {
  const lines = linesOf(file);
  const shown = (need ?? []).slice(0, 4);
  const text = shown.map(([a, b]) => windowOf(lines, a, b)).join(' · ');
  if (!text) return 'the whole file';
  // Three windows listed, three read: the list did not say any one is enough.
  const one =
    shown.length > 1
      ? ' — any ONE of these lifts the gate (the first is the best match): read only that one'
      : '';
  return `${text}${text.includes(' + ') ? SPLIT_NOTE : ''}${one}`;
}
// Is every line of `range` inside the union of `windows`?
function covered(windows, [from, to]) {
  let at = from;
  for (const [a, b] of [...windows].sort((x, y) => x[0] - y[0])) {
    if (a > at) break;
    if (b >= at) at = b + 1;
    if (at > to) return true;
  }
  return at > to;
}

// Review depth gates only where a review is PUBLISHED: the card gate once fired on a read of the MR's
// discussions while a session answered threads on its own MR, and a 10-line Read of an unrelated section
// lifted it — two turns that proved nothing. Read-only forge calls and thread replies keep the injection
// (the card included), never the deny.
const REVIEW_PUBLISH_MCP =
  /^mcp__[^_]*(?:gitlab|github)[^_]*__(?:(?:create_merge_request_thread|create_draft_note|create_merge_request_note|bulk_publish_draft_notes)$|create_pull_request_review|add_pull_request_review_comment)/i;
const LOOKUP = /^(Read|Grep|Glob)$/;
/** Is this call `rule`'s moment while it is still only a card? cardGate denies it unless a METHOD rule. */
function gates(rule, input) {
  const tool = String(input?.tool_name ?? '');
  // Lookups act on nothing, and the Read that lifts the gate must never be the call it denies (a Read
  // of a test file is a verification-depth trigger).
  if (LOOKUP.test(tool)) return false;
  // Doc placement decides where a NEW file goes; a file already on disk has its place (a split group:
  // 7 denies were Edits of an existing .agent/PROGRESS.md right after a compaction). The card still rides.
  if (rule === 'doc-classification') return !existingDoc(input);
  // The ledger write is the act the task-ledger Stop gate demands; refusing it until a Read would fight that gate.
  if (rule === 'task-ledger') return false;
  // Mid rebase/merge the edit resolves conflict hunks, it authors nothing (an Edit whose old_string began
  // `<<<<<<< HEAD` was denied for a rule card). Shots ride as context, no deny.
  if (MERGE_RIDES.has(rule) && mergeInProgress(input)) return false;
  return rule !== 'review-depth' || REVIEW_PUBLISH_MCP.test(tool);
}
const MERGE_RIDES = new Set(['visible-fix-shots']);
const MERGE_MARKS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'];
/** Is a rebase/merge/cherry-pick in progress in the repo holding the call's file (else its cwd)? */
export function mergeInProgress(input) {
  const raw = String(input?.tool_input?.file_path ?? '');
  const cwd = String(input?.cwd ?? process.cwd());
  let d = raw ? dirname(isAbsolute(raw) ? raw : join(cwd, raw)) : cwd;
  for (let i = 0; i < 64; i++) {
    const dotGit = join(d, '.git');
    let st = null;
    try {
      st = statSync(dotGit);
    } catch {
      /* not here — go up */
    }
    if (st) {
      let gitDir = dotGit;
      // A worktree's `.git` is a file naming its own git dir (`<main>/.git/worktrees/<name>`), where its
      // rebase state and MERGE_HEAD live.
      if (st.isFile()) {
        let m = null;
        try {
          m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
        } catch {
          /* unreadable → no state */
        }
        if (!m) return false;
        gitDir = isAbsolute(m[1]) ? m[1] : join(d, m[1]);
      }
      return MERGE_MARKS.some((n) => existsSync(join(gitDir, n)));
    }
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
}
// A docs site's page (a `content/` tree) that already exists is product text with its place fixed;
// placement has nothing to decide (2k of doc-classification on an Edit of an existing `.mdx` page).
// A NEW page keeps the rule.
const SITE_CONTENT = /(?:^|[\\/])content[\\/]/i;
function siteContent(input) {
  return SITE_CONTENT.test(String(input?.tool_input?.file_path ?? '')) && existingDoc(input);
}
function existingDoc(input) {
  const raw = String(input?.tool_input?.file_path ?? '');
  if (!raw) return false;
  try {
    return statSync(
      isAbsolute(raw) ? raw : join(String(input?.cwd ?? process.cwd()), raw),
    ).isFile();
  } catch {
    return false;
  }
}
// Rules on HOW a check is done (g5 25.10, K4): their deny bought nothing — an Edit of a `_test.go` was
// denied, the same 7k sent again 13 s later and the call repeated unchanged. Their whole text rides WITH
// the call as context and the call proceeds. The deny stays for rules whose breach is published or
// irreversible (published-text, git-writes, forge-protocol, a published review).
const METHOD_RULES = new Set(['verification-depth', 'live-check']);
// The tools that DECIDE the depth: their ladder is explained by verification-depth alone.
const DEPTH_TOOLS = /\b(risk-tier|mustfail)\.mjs\b/i;
/** A Bash call that only RUNS a check: verification-depth is about writing tests, its card adds nothing. */
function checkRun(input) {
  return (
    String(input?.tool_name ?? '') === 'Bash' &&
    !DEPTH_TOOLS.test(runnable(String(input?.tool_input?.command ?? '')))
  );
}
/** Does this call carry `rule`'s whole file when the session holds only its card? */
function feeds(rule, input) {
  return gates(rule, input) && !(rule === 'verification-depth' && checkRun(input));
}
// The rule file as it is on disk, whole — never clipped (a deny that carried half a rule would lift the
// gate on half a rule).
function fileText(file) {
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}
// Gated rules whose whole text THIS process attached to the call (`session:rule` → { file, sibling? }).
// In-process on purpose: cardGate runs right after ruleInjector in the same dispatcher, and a flag that
// outlived the process would claim a text was attached to a call that never carried it.
const fed = new Map();
// Parallel calls of one batch run concurrent hook processes; each would attach the same 7k. The first to
// create the mark attaches it, the others point at that deny. Fresh for FEED_SIBLING_MS only — the gate
// is re-armed after the next compaction and must feed again.
const FEED_SIBLING_MS = 15_000;
// `kind` 'open' = the section list of a rule too big to attach: g5 25.10 four parallel Edits each carried
// the same ~650-char list (10 denies, 6.5k chars); the first carries it, the rest point at it.
const fedMarkOf = (session, rule, kind = 'fed') => join(CACHE, `rule-${kind}-${rule}-${session}`);
function claimFeed(session, rule, kind = 'fed') {
  const mark = fedMarkOf(session, rule, kind);
  try {
    if (Date.now() - statSync(mark).mtimeMs > FEED_SIBLING_MS) unlinkSync(mark);
  } catch {
    /* no mark yet */
  }
  try {
    stateDir('rules');
    writeFileSync(mark, '1', { flag: 'wx' });
    return true;
  } catch (e) {
    return e?.code !== 'EEXIST'; // cannot mark → attach anyway: a repeat costs tokens, a miss a rule
  }
}

// A panel one-time grant replay (g9 26.10, D-12 at 12:39): the human — or the panel's re-check — allowed
// a deferred call, and the panel's prompt names it character for character: `tool <T> with this input,
// unchanged (a one-time grant; any other call is not covered):\n<canonical JSON>` (server
// `domains/chat/deferred-asks/texts.ts` exactCall). The grant matches only a byte-identical input, so
// reading a rule cannot change that call; two card denies there cost two turns and re-sent context.
// Only user-role text is the panel speaking — a tool result quoting the line is not.
const GRANT_CALL =
  /tool (\S+) with this input, unchanged \(a one-time grant; any other call is not covered\):\n(\{[^\n]*\})/g;
const COSMETIC = (tool, key) =>
  key === 'description' || (tool === 'Bash' && (key === 'timeout' || key === 'run_in_background'));
/** The panel's canonical JSON (keys sorted at every depth, undefined dropped) — hash.ts canonicalJson. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
/** Is this call the exact call a panel one-time grant in this transcript names? */
export function grantedReplay(input) {
  const tool = String(input?.tool_name ?? '');
  const given = input?.tool_input;
  if (!tool || !given || typeof given !== 'object') return false;
  const own = canonicalJson(
    Object.fromEntries(Object.entries(given).filter(([k]) => !COSMETIC(tool, k))),
  );
  let text;
  try {
    text = readFileSync(String(input?.transcript_path ?? ''), 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    if (!line.includes('a one-time grant')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== 'user' || rec?.message?.role !== 'user') continue;
    const c = rec.message.content;
    let said = typeof c === 'string' ? c : '';
    if (Array.isArray(c))
      said = c
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n');
    for (const m of said.matchAll(GRANT_CALL)) if (m[1] === tool && m[2] === own) return true;
  }
  return false;
}

/** @returns {string|null} a deny reason while a card this call triggers is still unread, else null. */
export function cardGate(input) {
  if (!splitChild() || injectOff()) return null;
  if (LOOKUP.test(String(input?.tool_name ?? ''))) return null;
  const session = String(input?.session_id ?? 'x').slice(0, 12);
  const gate = existsSync(gateOf(session)) ? readGate(session) : {};
  // Each rule judged on its own call: this one, or the Edit of a file a script of this call writes.
  const as = new Map();
  for (const { rule, via } of wantedOf(input)) as.set(rule, via ?? input);
  const due = [...as.keys()].filter(
    (rule) => gates(rule, as.get(rule)) && (gate[rule] || fed.has(`${session}:${rule}`)),
  );
  if (!due.length) return null;
  const granted = grantedReplay(input);
  const open = [];
  const openSibling = [];
  const attached = [];
  const sibling = [];
  const refused = [];
  let changed = false;
  for (const rule of due) {
    // A later call of the batch an earlier call was refused in: written blind like it, let through (see
    // batchSibling); the note beside it came from ruleInjector.
    if (batchSibling(session, rule, input)) continue;
    if (granted) {
      // Never denied (see grantedReplay); text riding with THIS call lifts the gate as its deny would.
      const feed = fed.get(`${session}:${rule}`);
      if (feed && !feed.sibling && gate[rule]) {
        delete gate[rule];
        changed = true;
      }
      fed.delete(`${session}:${rule}`);
      continue;
    }
    refused.push(rule);
    const feed = fed.get(`${session}:${rule}`);
    // A method rule is only tidied here, never denied: the text riding with this call (or a parallel
    // call's) IS its delivery, and an entry whose file is gone or already Read goes the same way.
    const method = METHOD_RULES.has(rule);
    if (feed) {
      // This deny carries the whole file (or a parallel call's deny does): it lifts the gate itself.
      fed.delete(`${session}:${rule}`);
      if (gate[rule]) {
        delete gate[rule];
        changed = true;
      }
      if (method) continue;
      (feed.sibling ? sibling : attached).push(
        `${rule} (${String(feed.file).replace(/\\/g, '/')})`,
      );
      continue;
    }
    const { file, head } = gate[rule];
    let readable = true;
    try {
      readFileSync(file);
    } catch {
      readable = false;
    }
    const need = readable ? needOf(file, as.get(rule)) : null;
    const seen = readable ? readInTranscript(input?.transcript_path, file, need) : null;
    if (!readable || seen !== false) {
      delete gate[rule];
      changed = true;
    } else if (method) continue;
    else if (claimFeed(session, rule, 'open')) open.push({ file, head, need });
    else openSibling.push(`${rule} (${String(file).replace(/\\/g, '/')})`);
  }
  if (changed) writeGate(session, gate);
  if (!open.length && !attached.length && !sibling.length && !openSibling.length) return null;
  markBatch(session, refused, input);
  const parts = [];
  if (openSibling.length)
    parts.push(
      `rule-card: this call needs ${openSibling.join(', ')}, which this session has only as a card. Its ` +
        'section list is in the deny of a parallel call in this same batch: Read the section covering ' +
        'your work from there, then repeat this call.',
    );
  if (attached.length)
    parts.push(
      `rule-card: this call needs ${attached.join(', ')}, which this session had only as a card. The full ` +
        `text (the whole file) is attached to this deny as hook context: read it, apply it to this call, ` +
        `then repeat the call. No separate Read is needed — this deny lifts the gate. Later calls of this ` +
        `same batch are let through: check them against it too.`,
    );
  if (sibling.length)
    parts.push(
      `rule-card: this call needs ${sibling.join(', ')}, which this session had only as a card. Its full ` +
        `text is attached to the deny of a parallel call in this same batch: read it there, then repeat ` +
        `this call (the gate is lifted).`,
    );
  if (open.length)
    parts.push(
      'rule-card: this call needs a rule this session got only as a card — the card is not the rule. ' +
        open
          .map(
            ({ file, head, need }) =>
              `${head}\nRead ${String(file).replace(/\\/g, '/')} first — one whole window of: ${windowsOf(need, file)} (a fragment of a section does not count)`,
          )
          .join('\n') +
        ', then repeat this call. Later calls of this same batch are let through: check them against it too.',
    );
  return parts.join('\n');
}

/**
 * Is cardGate certain to refuse this call, judged before ruleInjector runs and with no side effect? Only
 * the gate on disk counts — a card armed by this very call is not seen, so `false` proves nothing. The
 * dispatcher uses it to skip push-sieves (one `git fetch` + blame, ~9 s), which ran on the push the card
 * then refused, and again on its repeat (g8 26.10). Sieves skipped and no refusal after all → run them.
 */
export function cardDenies(input) {
  if (!splitChild() || injectOff()) return false;
  if (LOOKUP.test(String(input?.tool_name ?? ''))) return false;
  const session = String(input?.session_id ?? 'x').slice(0, 12);
  if (!existsSync(gateOf(session))) return false;
  const gate = readGate(session);
  for (const { rule, via } of wantedOf(input)) {
    const as = via ?? input;
    if (!gate[rule] || METHOD_RULES.has(rule) || !gates(rule, as)) continue;
    if (batchSibling(session, rule, input)) continue;
    const { file } = gate[rule];
    if (!fileText(file)) continue;
    if (readInTranscript(input?.transcript_path, file, needOf(file, as)) !== false) continue;
    return !grantedReplay(input);
  }
  return false;
}

// Batch siblings (a split group's audit, 26.10.2026): the CLI streams a batch and runs each call's hook as
// its block completes, so the 2nd..Nth Edit of a batch are written before the model can see the 1st one's
// deny — 47 denies in 21 batches, every Edit re-emitted. Now only the first call of the batch is refused
// for a rule; its deny carries the text (or the window), and later calls of the same batch — the same
// assistant message id in the transcript — pass with a note. Not a repeat-escape: a repeat is a new model
// output, i.e. a new batch, and meets the gate.
const batchMarkOf = (session) => join(CACHE, `rule-batch-${session}.json`);
const batchMemo = new Map();
/** The assistant message id carrying tool_use `id` (the batch it belongs to), or null when not on record. */
export function batchOf(transcript, id) {
  if (!id || !transcript) return null;
  const key = `${transcript}|${id}`;
  if (batchMemo.has(key)) return batchMemo.get(key);
  let msg = null;
  try {
    const text = readFileSync(String(transcript), 'utf8');
    const at = text.lastIndexOf(`"id":"${id}"`);
    if (at >= 0) {
      const end = text.indexOf('\n', at);
      const rec = JSON.parse(text.slice(text.lastIndexOf('\n', at) + 1, end < 0 ? undefined : end));
      if (rec?.type === 'assistant' && rec.message?.id) msg = String(rec.message.id);
    }
  } catch {
    msg = null; // no transcript, a torn line: not provably a sibling → the gate decides as before
  }
  batchMemo.set(key, msg);
  return msg;
}
function readBatch(session) {
  try {
    return JSON.parse(readFileSync(batchMarkOf(session), 'utf8')) ?? {};
  } catch {
    return {};
  }
}
/** The refusal this call is a later sibling of (same batch, same rule), or null. */
function batchSibling(session, rule, input) {
  const mark = readBatch(session)[rule];
  if (!mark?.msg || !input?.tool_use_id || mark.id === input.tool_use_id) return null;
  return batchOf(input?.transcript_path, input.tool_use_id) === mark.msg ? mark : null;
}
function markBatch(session, rules, input) {
  if (!rules.length) return;
  const msg = batchOf(input?.transcript_path, input?.tool_use_id);
  if (!msg) return;
  const marks = readBatch(session);
  for (const rule of rules) marks[rule] = { msg, id: input.tool_use_id };
  try {
    stateDir('rules');
    writeFileSync(batchMarkOf(session), JSON.stringify(marks));
  } catch {
    /* a lost mark costs the old sibling deny, never the gate */
  }
}
const siblingNote = (rule) =>
  `rule-card: ${rule} — an earlier call of this same batch was refused for it and its deny carries the ` +
  `text (or the window to Read). This call was let through, written before you saw it: check it against that rule.`;

/**
 * Drop this session's stamps so every rule is delivered again.
 * Called from PreCompact: compaction takes the rule text out of the window, and a stamp that
 * outlives it turns "delivered once" into "never again for the rest of the session".
 */
export function clearRuleStamps(session) {
  const key = String(session ?? '').slice(0, 12);
  // No session id = nobody's stamps. An empty key used to match every file (''.includes is always
  // true): the garbage-input suite drives precompact-checkpoint with no session_id, so each run of the
  // hook tests erased the stamps of every LIVE session and all of them were re-sent every rule.
  const own = (f) => key.length >= 4 && f.endsWith(`-${key}.stamp`);
  // A compaction is the one LEGITIMATE reason to send a rule again; the marker is what lets
  // ruleRepeats() tell it from a wipe.
  if (key.length >= 4) logDelivery(key, '#compact', 0);
  try {
    for (const f of readdirSync(CACHE)) {
      if (
        !f.startsWith('rule-') ||
        !(f.endsWith('.stamp') || f.endsWith('.sent') || f.endsWith('.json'))
      )
        continue;
      const path = join(CACHE, f);
      // Own stamps go now; anyone else's go once they are a week stale — the cache had grown to
      // 200 dead files from finished sessions. A `.sent` mark is never "own": it must outlive compaction.
      const stale = !own(f) && Date.now() - statSync(path).mtimeMs > 7 * 24 * 3600e3;
      if (own(f) || stale) unlinkSync(path);
    }
  } catch {
    /* a stamp that cannot be cleared costs one missed re-delivery, never the compaction */
  }
}

// Cards right after a compaction (g9 26.10): the card used to arrive with the FIRST call that needed it —
// in practice the first Edit of a parallel batch — so every Edit of that batch was denied together (8 at
// 21:32Z, 6 at 21:19Z; ~5 storms/h, each re-emitting the Edits after the Read over a 30–60k context). A
// split child now gets, at SessionStart:compact, the cards of the gated rules its calls of the generation
// that just ended needed, with their gates armed and stamps written, plus the window the gate will ask
// for — so it can Read before the batch. A model that edits first meets today's deny unchanged. Logged
// after PreCompact's `#compact`, so ruleRepeats() sees one delivery of this generation, not a repeat.
// The kit's SessionStart block of a split child's compaction is capped at 9000 (items.mjs, 4000 elsewhere);
// the budget is what the earlier SessionStart items left of it (`kit_room`), at most PRESEND_MAX.
// g9 review 26.10 (F3): 8 compactions in one fix stage, each followed by a card deny and a 5–16k re-read of
// the same rule. The window the gate would ask for, when it fits this budget, is now sent as TEXT: that is
// the read, so the rule is stamped delivered and no gate is armed for it. Bigger windows keep card + gate.
export const PRESEND_MAX = 6000;
const TEXT_HEAD =
  'rule text after compaction: this session needed the rule sections below before it, and their text left ' +
  'the window. Each is the section the card gate asks for, sent whole — it counts as the Read: apply it to ' +
  'the next Edit/Write of those files, no Read needed.';

/** The gate's best window (`range` of `path`) as presend text with its label; null when empty or unreadable. */
function windowText(path, range, label) {
  if (!range) return null;
  const lines = linesOf(path);
  const [a, b] = range;
  const body = lines
    .slice(a - 1, Math.min(b, lines.length))
    .join('\n')
    .replace(/\s+$/, '');
  if (!body.trim()) return null;
  return `${label}: ${path.replace(/\\/g, '/')} lines ${a}-${b}, sent whole:\n${body}`;
}

/**
 * The tool calls of the generation that just ended. The hook may run before or after the CLI writes the
 * new boundary (g9: hook output 21:46:17.003Z, boundary record 21:46:17.371Z): no call after the last
 * boundary = that one is new, and the generation is the stretch before it. Each call keeps its record's cwd.
 */
function lastGeneration(transcript) {
  let lines;
  try {
    lines = readFileSync(String(transcript ?? ''), 'utf8').split('\n');
  } catch {
    return null;
  }
  const bounds = lines.flatMap((l, i) => (l.includes('"subtype":"compact_boundary"') ? [i] : []));
  const calls = (from, to) => {
    const out = [];
    for (let i = from; i < to; i++) {
      if (!lines[i].includes('"tool_use"')) continue;
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (rec?.type !== 'assistant' || rec.isSidechain) continue;
      for (const b of Array.isArray(rec.message?.content) ? rec.message.content : [])
        if (b?.type === 'tool_use')
          out.push({ tool_name: String(b.name ?? ''), tool_input: b.input ?? {}, cwd: rec.cwd });
    }
    return out;
  };
  const last = bounds.length ? bounds[bounds.length - 1] : -1;
  const after = calls(last + 1, lines.length);
  if (after.length || last < 0) return after;
  return calls(bounds.length > 1 ? bounds[bounds.length - 2] + 1 : 0, last);
}

/**
 * PreCompact of a CLI whose transcript the kit cannot read (P-29): a `compact` marker in the kit's session
 * log, the boundary `kitGeneration` cuts at. Claude's own transcript carries `compact_boundary` already.
 */
export function markCompaction(input) {
  if (cliOf(input) !== 'claude') logSessionEvent(input, { kind: 'compact' });
}

/**
 * The generation that just ended, for a non-Claude CLI: the calls the kit let through at PreToolUse
 * (session log `call`, logged as normalized — an Edit/Write keeps its file), cut at `compact` markers with
 * `lastGeneration`'s boundary logic. Its transcript (Qwen, Codex) has no Claude `tool_use` records, so
 * that reader returned nothing and the first edit after every compaction met a card deny (P-29).
 */
function kitGeneration(input) {
  const events = sessionEvents(input);
  const bounds = events.flatMap((e, i) => (e?.kind === 'compact' ? [i] : []));
  const calls = (from, to) =>
    events.slice(from, to).flatMap((e) =>
      e?.kind !== 'call'
        ? []
        : [
            {
              tool_name: String(e.tool ?? ''),
              tool_input: e.file ? { file_path: e.file } : e.cmd ? { command: e.cmd } : {},
            },
          ],
    );
  const last = bounds.length ? bounds[bounds.length - 1] : -1;
  const after = calls(last + 1, events.length);
  if (after.length || last < 0) return after;
  return calls(bounds.length > 1 ? bounds[bounds.length - 2] + 1 : 0, last);
}

/** @returns {string|null} the cards to pre-send at SessionStart:compact in a split child, else null. */
export function compactCards(input, budget = PRESEND_MAX) {
  if (!splitChild() || injectOff() || input?.source !== 'compact') return null;
  const session = String(input?.session_id ?? '').slice(0, 12);
  if (session.length < 4) return null;
  const calls =
    cliOf(input) === 'claude' ? lastGeneration(input?.transcript_path) : kitGeneration(input);
  if (!calls?.length) return null;
  // rule → the latest call of that generation the gate would have judged (its file kind names the window).
  const needed = new Map();
  for (const call of calls)
    for (const w of wantedOf({ ...input, ...call, cwd: call.cwd ?? input?.cwd })) {
      const via = w.via ?? { ...input, ...call };
      if (METHOD_RULES.has(w.rule) || !gates(w.rule, via)) continue;
      needed.delete(w.rule);
      needed.set(w.rule, { ...w, via });
    }
  const copy = copyKey(input?.cwd);
  const ready = [];
  for (const { rule, text, file, via } of needed.values()) {
    const body = text ? text() : read(rule);
    if (!body) continue;
    // Only a rule whose next delivery would be a card: a session that never got it whole gets it whole.
    const inSession = existsSync(sentOf(session, rule));
    if (!inSession && !(body.length >= COPY_CARD_MIN && copy && existsSync(sentOf(copy, rule))))
      continue;
    const path = file ?? join(RULES, `${rule}.md`);
    const edited = String(via?.tool_input?.file_path ?? via?.tool_input?.notebook_path ?? '');
    const kind = /\.[a-z0-9]+$/i.exec(edited)?.[0];
    const label = `- ${rule}${kind ? ` (${kind} files)` : ''}`;
    const need = needOf(path, via);
    const line = `${label}: Read ${path.replace(/\\/g, '/')} — one whole window of: ${windowsOf(need, path)}`;
    ready.push({
      rule,
      path,
      line,
      card: cardOf(body, path, rule, inSession ? 'session' : 'copy'),
      size: fileText(path)?.length ?? 0,
      window: windowText(path, need?.[0], label),
    });
  }
  // The biggest first: a small rule rides whole with its deny, a big one only ever arrives by a Read.
  ready.sort((a, b) => b.size - a.size);
  const head =
    'rule-cards after compaction: this session needed the rules below before it, and their text left the ' +
    'window. Read each named window BEFORE the next Edit/Write of the files that need it — those calls ' +
    'are refused until then (all the Reads in one batch, then the edits).';
  const cost = (r) => r.line.length + r.card.length + 3;
  let used = head.length + TEXT_HEAD.length + 2;
  const chosen = new Set();
  for (const r of ready) {
    if (used + cost(r) > budget) continue;
    chosen.add(r);
    used += cost(r);
  }
  // Text instead of a card where the room allows, the smallest window first.
  const asText = new Set();
  for (const r of [...ready].sort((a, b) => (a.window?.length ?? 0) - (b.window?.length ?? 0))) {
    if (!r.window) continue;
    const extra = r.window.length + 2 - (chosen.has(r) ? cost(r) : 0);
    if (used + extra > budget) continue;
    asText.add(r);
    chosen.add(r);
    used += extra;
  }
  const lines = [];
  const cards = [];
  const texts = [];
  for (const r of ready) {
    if (!chosen.has(r) || alreadySent(session, r.rule)) continue;
    if (asText.has(r)) {
      logDelivery(session, r.rule, r.window.length, { presend: true });
      texts.push(r.window);
      continue;
    }
    armCard(session, r.rule, r.path, r.card);
    logDelivery(session, r.rule, r.line.length + r.card.length, { presend: true });
    lines.push(r.line);
    cards.push(r.card);
  }
  // A gate armed before the compaction outlives it, and no Read after the boundary lifts it: the text
  // sent here is that read.
  const gate = readGate(session);
  const lifted = [...asText].filter((r) => gate[r.rule]);
  if (lifted.length) {
    for (const r of lifted) delete gate[r.rule];
    writeGate(session, gate);
  }
  const out = [];
  if (texts.length) out.push(`${TEXT_HEAD}\n\n${texts.join('\n\n')}`);
  if (lines.length) out.push(`${head}\n${lines.join('\n')}\n\n${cards.join('\n\n')}`);
  return out.length ? out.join('\n\n') : null;
}

// Split group only: "this rule reached the session once". Not a `.stamp`, so compaction keeps it.
const sentOf = (session, name) => join(CACHE, `rule-${name}-${session}.sent`);
function markSent(session, name) {
  try {
    stateDir('rules');
    writeFileSync(sentOf(session, name), '1');
  } catch {
    /* a lost mark costs one whole re-delivery, never the rule */
  }
}

/**
 * Split-group re-delivery (see CARD_MAX): the header and the Read pointer go first so a clip never
 * eats them; the lead (text before the first section) fills what is left. Binding as a whole.
 */
export function cardOf(body, file, name = 'rule', reached = 'session') {
  const title = /^# +(.+)$/m.exec(body)?.[1]?.trim() ?? name;
  const path = file.split('\\').join('/');
  let lines = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    /* no file to window — the path alone still says where the rule lives */
  }
  const starts = lines.flatMap((l, i) => (l.startsWith('## ') ? [i] : []));
  // Each window Read-sized; a sectionless file over Read's cap is named in parts too.
  const sections = starts
    .map(
      (s, k) =>
        `${lines[s].slice(3).trim()} ${windowOf(lines, s + 1, starts[k + 1] ?? lines.length)}`,
    )
    .join(' · ');
  const whole = !starts.length && lines.length ? windowOf(lines, 1, lines.length) : '';
  const windows = sections || (whole.includes(' + ') ? whole : '');
  const note = windows.includes(' + ') ? SPLIT_NOTE : '';
  let where = ' before acting';
  if (sections) where = ` — the section covering your work, before acting: ${windows}${note}`;
  else if (windows) where = ` before acting — the whole file, in parts: ${windows}${note}`;
  const head =
    (reached === 'copy'
      ? `# ${title} — card (split group: the full text reached an earlier stage of this copy, not this session)\n`
      : `# ${title} — card (split group, re-sent after compaction; the full text reached this session before)\n`) +
    `Still binding in full: Read ${path}${where}\n`;
  const titleAt = body.search(/^# /m);
  const afterTitle = titleAt < 0 ? body : body.slice(body.indexOf('\n', titleAt) + 1);
  const cut = afterTitle.indexOf('\n## ');
  const lead = (cut < 0 ? afterTitle : afterTitle.slice(0, cut))
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const room = CARD_MAX - head.length;
  if (room < 40 || !lead) return head.slice(0, CARD_MAX).trimEnd();
  return `${head}${lead.length > room ? `${lead.slice(0, room - 1).trimEnd()}…` : lead}`;
}

function read(name) {
  try {
    const t = readFileSync(join(RULES, `${name}.md`), 'utf8').trim();
    // A big rule is delivered whole: it is here precisely because it is too long to live in the
    // always-loaded memory, and half a rule reads as the complete one.
    if (BIG_RULES.has(name)) return t;
    return t.length > MAX_RULE ? `${t.slice(0, MAX_RULE)}…` : t;
  } catch {
    return null; // a disabled or missing rule file is simply not delivered
  }
}

/**
 * One line per delivery, so a repeat is a number instead of an impression: `context-budget` reads this
 * at SessionStart and names any rule that reached one session more than once per compaction.
 */
export const DELIVERY_LOG = join(CACHE, 'rule-deliveries.jsonl');
function logDelivery(session, rule, bytes, extra = null) {
  // The test suite is not a session, and neither is `x` — the key of a call that carried no id. (The kit's
  // suites run on their own AGENTDECK_KIT_STATE, so their rows never reach a live log; the global twin's
  // suites share ~/.claude/cache and are refused by the CLI-session key there.)
  if (/^tst|^x$/.test(session)) return;
  try {
    appendFileSync(
      DELIVERY_LOG,
      `${JSON.stringify({ t: Date.now(), s: session, rule, bytes, ...extra })}\n`,
    );
  } catch {
    /* a lost log line costs a statistic, never the rule */
  }
}

/**
 * Rules that reached one session more than once within one compaction generation, over the last 7
 * days — or null. A repeat is 0.7–1.4k tokens paid twice, and until it was counted it was only ever
 * noticed by accident. Also keeps the log to a week.
 */
export function ruleRepeats(now = Date.now(), file = DELIVERY_LOG) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
  const since = now - 7 * 24 * 3600e3;
  const generation = new Map();
  const seen = new Set();
  const repeats = new Map();
  const keep = [];
  let wasted = 0;
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!(e?.t >= since)) continue;
    keep.push(line);
    // A card pre-sent at SessionStart:compact is not a wipe: the whole text a deny then attaches (the
    // model edited before reading) supersedes it inside the same generation and is the one counted.
    if (e.presend) continue;
    // Rows a test suite wrote before logDelivery refused them (the suites' `tst…` / `tce…` keys).
    if (/^(tst|tce)/.test(String(e.s))) continue;
    if (e.rule === '#compact') {
      generation.set(e.s, (generation.get(e.s) ?? 0) + 1);
      continue;
    }
    // A card, then the text the gate's deny attaches (`feed`), is one delivery in two steps, not a wipe:
    // the feed is keyed apart, so only a second feed or a second plain send counts.
    const k = `${e.s}|${generation.get(e.s) ?? 0}|${e.rule}${e.feed ? '|feed' : ''}`;
    if (seen.has(k)) {
      repeats.set(e.rule, (repeats.get(e.rule) ?? 0) + 1);
      wasted += Number(e.bytes) || 0;
    }
    seen.add(k);
  }
  if (keep.length < lines.length)
    try {
      writeFileSync(file, `${keep.join('\n')}\n`);
    } catch {
      /* an untrimmed log is a few KB, not a failure */
    }
  if (!repeats.size) return null;
  const top = [...repeats]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r, n]) => `${r} x${n}`)
    .join(', ');
  return `rules re-sent inside one session, 7d: ${top} = ${Math.round(wasted / 400) / 10}k tok wasted; something wipes rule stamps, see <kit>/hooks/lib/rule-injector.mjs`;
}

const stampOf = (session, name) => join(CACHE, `rule-${name}-${session}.stamp`);
function alreadySent(session, name) {
  const stamp = stampOf(session, name);
  if (existsSync(stamp)) return true;
  try {
    stateDir('rules');
    // Exclusive create: two dispatchers woken by one tool call both saw "no stamp" and both delivered.
    // Whoever loses the race now gets EEXIST, which is the answer "already sent".
    writeFileSync(stamp, '1', { flag: 'wx' });
  } catch (e) {
    if (e?.code === 'EEXIST') return true;
    /* cannot dedupe → inject again rather than lose the rule */
  }
  return false;
}
