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
} from 'node:fs';
import { join } from 'node:path';
import { RULES_DIR, STATE_DIR, stateDir } from './kit-paths.mjs';

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

// Doc placement matters at exactly one moment: a Markdown file is about to be written. Held in the
// always-loaded memory the block cost ~450 tok on every turn of every session, most of which never
// write a doc. Placement itself is still enforced by agent-doc-location / doc-bloat-guard — this
// text is the reasoning behind their verdicts, delivered when a doc is actually being authored.
const DOC_FILE = /\.mdx?$/i;

// Before/after shots: the procedure is only ever needed once a UI file is actually in hand, and it
// must arrive BEFORE the first edit — hence reads count as the trigger, the same fix as incident 3.
// The invariant itself stays in CLAUDE.md; this delivers the steps.
const UI_SOURCE = /\.(tsx?|jsx?|vue|svelte|css|scss|less)$/i;

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
/** Ceiling the dispatcher must allow so the largest deliberate payload is not clipped on its way out. */
export const MAX_RULE_CEILING = Math.max(MAX_RULE * 2, ...[...BIG_RULES].map(sizeOf)) + 512;

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
export function runnable(cmd) {
  return String(cmd ?? '')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => q.replace(/[|;&\n]/g, ' '))
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
export default function ruleInjector(input) {
  if (process.env.AGENTDECK_KIT_RULE_INJECT === '0' || process.env.CLAUDE_RULE_INJECT === '0')
    return null;
  const tool = String(input?.tool_name ?? '');
  const cmd = String(input?.tool_input?.command ?? '');
  const run = runnable(cmd); // what the line EXECUTES — see runnable()
  const session = String(input?.session_id ?? 'x').slice(0, 12);

  const wanted = [];
  if (PUBLISH_CMD.test(cmd) || isPublishMcp(tool)) wanted.push({ rule: 'published-text' });
  if (FORGE_MCP.test(tool)) wanted.push({ rule: 'forge-protocol' });
  const editPath = String(input?.tool_input?.file_path ?? '');
  if (DOCKER_CMD.test(run) || (WRITE_TOOL.test(tool) && COMPOSE_FILE.test(editPath)))
    wanted.push({ rule: 'docker-shared' });
  if (WRITE_TOOL.test(tool) && DOC_FILE.test(editPath)) wanted.push({ rule: 'doc-classification' });
  if (GIT_WRITE_CMD.test(cmd)) wanted.push({ rule: 'git-writes' });
  if (LOCAL_MODEL_CMD.test(run)) wanted.push({ rule: 'local-models' });
  if (WRITE_TOOL.test(tool) && HOOK_SOURCE.test(editPath)) wanted.push({ rule: 'hook-authoring' });
  if (WRITE_TOOL.test(tool) && CONFIG_SOURCE.test(editPath)) wanted.push({ rule: 'config-work' });
  if (UI_TOOL.test(tool) && UI_SOURCE.test(editPath)) wanted.push({ rule: 'visible-fix-shots' });
  if (VERIFY_CMD.test(run) || (TEST_TOOL.test(tool) && TEST_FILE.test(editPath)))
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

  if (!wanted.length) return null;

  const out = [];
  for (const { rule, text } of wanted) {
    if (alreadySent(session, rule)) continue;
    const body = text ? text() : read(rule);
    if (body) {
      out.push(body);
      logDelivery(session, rule, body.length);
    }
  }
  return out.length ? out.join('\n\n') : null;
}

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
      if (!f.startsWith('rule-') || !f.endsWith('.stamp')) continue;
      const path = join(CACHE, f);
      // Own stamps go now; anyone else's go once they are a week stale — the cache had grown to
      // 200 dead files from finished sessions.
      const stale = !own(f) && Date.now() - statSync(path).mtimeMs > 7 * 24 * 3600e3;
      if (own(f) || stale) unlinkSync(path);
    }
  } catch {
    /* a stamp that cannot be cleared costs one missed re-delivery, never the compaction */
  }
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
function logDelivery(session, rule, bytes) {
  // The test suite is not a session, and neither is `x` — the key of a call that carried no id.
  if (/^tst|^x$/.test(session)) return;
  try {
    appendFileSync(DELIVERY_LOG, `${JSON.stringify({ t: Date.now(), s: session, rule, bytes })}\n`);
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
    if (e.rule === '#compact') {
      generation.set(e.s, (generation.get(e.s) ?? 0) + 1);
      continue;
    }
    const k = `${e.s}|${generation.get(e.s) ?? 0}|${e.rule}`;
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

function alreadySent(session, name) {
  const stamp = join(CACHE, `rule-${name}-${session}.stamp`);
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
