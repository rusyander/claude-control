// watchdog core — incremental reader of Claude Code transcripts and plain logs. Every record becomes at most a
// one-line flag; offsets and per-file heuristics persist in <state>/watch-state.json, so each call reads only the
// bytes written since the previous one and a coordinator blocks on ONE call per quiet stretch (zero model tokens
// while nothing happens). Pre-flags are heuristics: they point at a record (#unit:n, opened by show.mjs), the
// coordinator judges it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { foreignFiles, toClaude } from './foreign.mjs';

// Census of 80 recent transcripts (CLI 2.1.310): bookkeeping records that never carry agent behaviour.
export const SKIP_TYPES = new Set([
  'api-request', 'api-request-blob', 'api-request-shape', 'atis-latch', 'last-prompt', 'file-history-snapshot',
  'file-history-delta', 'ai-title', 'mode', 'cost-state', 'permission-mode', 'isolation-latch', 'pr-link', 'summary',
  'custom-title', 'tag', 'agent-name', 'agent-setting',
]);
const KNOWN_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'queue-operation', ...SKIP_TYPES]);

export const T = {
  slowSec: 120, // a foreground call this long is a cost to look at
  openSec: 120, // a call still open this long is reported once
  bigChars: 20000, // a result this large lands in the context whole
  ctxJump: 20000, // one step that adds this much context
  ctxHigh: 180000, // compaction is near
  briefChars: 15000, // a prompt this long is a brief worth reading
  stallSec: 600, // no growth this long while the turn runs
  seedBytes: 512 * 1024, // tail scanned when a running file is first seen
  seedFreshMs: 6 * 3600e3, // older files are taken at their end without a scan
  chunkBytes: 8 * 1024 * 1024,
  bgStaleMs: 2 * 3600e3, // a bg entry with no notification this long is stale (its CLI died)
  bgLongSec: 600, // a background task or async subagent still running this long is reported once
  ring: 600, // refs kept per unit
  marks: 30, // audit marks kept per unit (show.mjs --pack reads from one)
};
// A file whose first record is this close before an event mark counts as born at it (clock skew between writers).
const BORN_SLACK_MS = 5e3;
// A conversation's first record and the panel's stage time of the same start differ by seconds (convMark).
const ADOPT_MS = 60e3;
// Waste that compounds: the same class twice inside one turn = a burn loop (BURN, hi) — a group pauses at once.
// Cheap classes are rowed and fixed, the unit pauses at its next safe point (a plugin arms it).
export const WASTE_BURN = new Set(['rerun', 'repeat', 'sleep', 'err-repeat']);
// max 120: every action reaches the watcher within 2 min even in a stretch with no flag (owner 25.10).
export const DEFAULTS = { max: 120, settle: 8, batch: 60, poll: 2, budget: 8000, backlog: 12, from: 'end' };

const isWin = process.platform === 'win32';
export const normP = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
export const insideOf = (child, parent) => {
  const c = normP(child);
  const p = normP(parent).replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + path.sep);
};
// Git Bash hands `name=log:/c/work/x` to node verbatim (MSYS converts only arguments that START with a path), and
// on Windows path.resolve reads `/c/work/x` as `C:\c\work\x` — a unit that silently watches nothing.
export const nativePath = (p) => {
  const s = String(p ?? '');
  return isWin && /^\/[a-zA-Z](?:\/|$)/.test(s) ? `${s[1].toUpperCase()}:${s.slice(2) || '/'}` : s;
};
export const one = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
export const hms = (ms) => new Date(ms).toTimeString().slice(0, 8);
// The zone hms() prints in, as a tag: a printer naming its clock keeps local and UTC times from mixing (F-15, 25.10).
export const zone = (ms = Date.now()) => {
  const o = -new Date(ms).getTimezoneOffset();
  const a = Math.abs(o);
  return `local UTC${o < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};
export const age = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};
export const kc = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
export const configRoot = (o) => nativePath(o?.['config-root'] || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
export const slugOf = (abs) => path.resolve(abs).replace(/[^a-zA-Z0-9]/g, '-');

// ---- heuristics --------------------------------------------------------------------------------------------
const SLEEP_RE = /(?:^|[;&|(\s"'`])sleep\s+\d|Start-Sleep|timeout(?:\.exe)?\s+\/t\s+\d|ping\s+-n\s+\d+\s+127\.0\.0\.1/i;
// A sleep is a wait only when this shell, a local wrapper or a runner it blocks on runs it. `docker create img sleep
// 600` hands sleep to a container as its command and returns at once — read as a wait it paused g3 on a false BURN
// (25.10). Judged by the head word of the sleep's own shell segment.
const SLEEP_SKIP = new Set(['do', 'then', 'else', 'elif', '!', '{', 'sudo', 'exec', 'command', 'builtin']);
const SLEEP_LOCAL = /^(?:time|nohup|env|nice|ionice|stdbuf|timeout|watch|xargs|caffeinate)$/i;
const SLEEP_SHELL = /^(?:(?:ba|z|da|k)?sh|pwsh|powershell|cmd)(?:\.exe)?$/i;
const SLEEP_RUNNER = /^(?:ssh|wsl|kubectl|oc|vagrant|docker|podman|nerdctl)(?:\.exe)?$/i;
// A zero sleep waits nothing: g1 27.10 prefixed `sleep 0;` to a delivery run and it read as a SLEEP owing a row.
const ZERO_SLEEP =
  /^[;&|(\s"'`]?(?:sleep\s+0+(?:\.0+)?[smhd]?(?![\w.])|Start-Sleep\s+(?:-\w+\s+)?0+(?:\.0+)?(?![\w.])|timeout(?:\.exe)?\s+\/t\s+0+(?!\d)|ping\s+-n\s+[01]\s)/i;
export const sleepWaits = (cmd) => {
  for (const m of String(cmd).matchAll(new RegExp(SLEEP_RE.source, 'gi'))) {
    if (ZERO_SLEEP.test(cmd.slice(m.index))) continue;
    const before = cmd.slice(0, m.index + (/^[;&|(\s"'`]/.test(m[0]) ? 1 : 0));
    const cut = Math.max(...[';', '&', '|', '(', '\n', '`'].map((c) => before.lastIndexOf(c)));
    const words = before.slice(cut + 1).split(/\s+/).map((w) => w.replace(/^["']+|["']+$/g, '')).filter(Boolean);
    while (words.length && (SLEEP_SKIP.has(words[0]) || /^\w+=/.test(words[0]))) words.shift();
    if (!words.length) return true;
    const head = words[0].split(/[\\/]/).pop();
    if (SLEEP_LOCAL.test(head)) return true;
    if (SLEEP_SHELL.test(head) && words.some((w) => /^[-/](?:c|Command|EncodedCommand)$/i.test(w))) return true;
    if (!SLEEP_RUNNER.test(head)) continue;
    const sub = words.slice(1).find((w) => !w.startsWith('-'));
    const detached = sub === 'create' || (/^(?:run|exec)$/.test(sub) && words.some((w) => w === '--detach' || /^-[a-z]*d[a-z]*$/.test(w)));
    if (!detached) return true;
  }
  return false;
};
// A loop probing a server it just started breaks the moment it answers — a readiness wait the kit allows
// (bg-wait-guard), not a poll: g1 26.10 waited 6 s for vite and read as a burn. A loop over a task output or a
// check log stays a SLEEP; a probe that runs long is SLOW like any call.
const PROBE_LOOP = /\b(?:for|while|until)\b[\s\S]*\b(?:curl|wget|nc|Test-NetConnection|Invoke-WebRequest)\b/i;
const AWAITS_RUN = /[\\/]tasks[\\/][^\s"']+\.output|(?:^|[^a-z0-9])(?:gate|test|check|lint|tsc|type|build|vitest|jest|mustfail|ci)[\w.-]*\.log\b/i;
export const probeLoop = (cmd) => PROBE_LOOP.test(String(cmd)) && !AWAITS_RUN.test(String(cmd));
const TREE_RE =
  /\bgit\s+(?:checkout|switch|reset|stash|pull|rebase|merge|cherry-pick|revert|am|apply|restore|clean)\b|\b(?:pnpm|npm|yarn|bun)\s+(?:i|install|add|remove|up|update)\b|(?:^|[;&|\s])(?:mv|rm|cp|mkdir|touch)\s|\bsed\s+-i|\btee\b|--write\b|--fix\b|(?:^|[^&>2])>{1,2}\s*[^&\s|]/;
const DENY_RE =
  /hook error:\s*\[|\[ctx-guard\]|Permission to use [\w:.-]+ (?:has been|was) denied|The user doesn't want to proceed with this tool use|tool use was rejected/i;
const TIMEOUT_RE = /Command timed out|timed out after|\bexit code 124\b|дольше предела|was killed after|exceeded the timeout/i;
const BENIGN_EXIT1 = /^\s*(?:grep|rg|egrep|fgrep|diff|cmp|test|\[|findstr|git\s+(?:diff\s+--quiet|grep|ls-files\s+--error-unmatch))\b/;
const WORD_RE = new RegExp(
  [
    String.raw`\bnot (?:verified|checked|tested|run)\b`, String.raw`\bunverified\b`,
    String.raw`\bskip(?:ped|ping)?\s+(?:the\s+|this\s+)?(?:check|test|gate|sieve|step|verification|review|hook)s?\b`,
    String.raw`\b(?:check|test|gate|sieve|step|verification|review)s?\s+(?:was\s+|were\s+|is\s+|are\s+)?skipped\b`,
    String.raw`\bwork ?around\b`, String.raw`\bfor now\b`, String.raw`\b(?:fix|do|handle|address|revisit) (?:it |this |that )?later\b`,
    String.raw`\bpre-?existing\b`, String.raw`\bnot related to (?:the|this|my|our) (?:change|branch|diff)\b`, String.raw`\bout of scope\b`,
    String.raw`\bflaky\b`, String.raw`\bignor(?:e|ing) (?:it|this|the (?:error|failure|warning))\b`,
    'не\\s*провер', 'непровер', '(?:^|[^а-яё])позже(?![а-яё])', 'потом\\s+(?:сделаю|поправ|додела)',
    '(?:пропуска[а-яё]*|пропущ[а-яё]*|пропуст[а-яё]*)\\s+(?:эт[а-яё]+\\s+)?(?:провер|тест|сит|шаг|гейт|ревью|хук)',
    '(?:провер[а-яё]*|тест[а-яё]*|сит[оа]|шаг[а-яё]*|гейт[а-яё]*)\\s+(?:был[аио]?\\s+)?пропущ',
    '(?:^|[^а-яё])в\\s+обход', '(?:^|[^а-яё])обход(?:ной|ом|им)', 'не\\s+из-за\\s+(?:ветки|правк|моих|наших)', 'не\\s+связан[а-яё]*\\s+с\\s+(?:правк|ветк|изменени)',
    'до\\s+меня', 'уже\\s+был[аио]?\\s+красн', '(?:^|[^а-яё])временно(?![а-яё])', 'заглушк', 'костыл',
  ].join('|'),
  'i',
);
const ERR_LINE = /\b(?:error|errors|failed|failure|fail|exception|panic|fatal|denied|timed? ?out|traceback|ERR!|FAIL)\b|✗|✖/i;
// «135 passed, 0 failed» / «0 errors» are suite summaries of a success — a log unit must not wake hi on them.
const ZERO_COUNT = /\b0\s+(?:failed|failures?|fail|errors?)\b/gi;
// A check = a command whose only output is a verdict on the tree: running it twice on one tree is pure cost.
const CHECK_RE =
  /\b(?:vitest|jest|mocha|tsc|eslint|prettier\s+(?:--check|-c)\b|biome\s+(?:check|lint)|go\s+(?:test|vet)|pytest|ruff|mypy|cargo\s+(?:test|check|clippy)|playwright\s+test|mustfail(?:\.mjs)?|gate-run(?:\.mjs)?|depcruise|(?:pnpm|npm|yarn|bun)\s+(?:(?:-C|--dir|--filter|-F)\s+\S+\s+)*(?:run\s+)?(?:test|lint|type-?check|typecheck|check|gate|depcruise|compromises|negatives|shots|brand|format:check)\b|tests-cli\.mjs\s+run|tools\/qa\/[\w-]+\.mjs|(?:scripts|tools)\/check[_-][\w-]+\.(?:mjs|js|py|sh)\b)/i;
// The check word as a whole token: `eslint.config.js`, `tmp-vitest.log`, `tsconfig.json` name files, not a run
// (GAP #g5:206 `sed … eslint.config.js || ls …`, #g9:36 `grep … tmp-vitest.log`, 25.10).
const CHECK_TOKEN = new RegExp(`(?<![\\w.-])${CHECK_RE.source.slice(2)}(?![\\w.-])`, 'i');
// A verdict asked of a checker again and again in one turn with only evidence files edited between = the group argues
// with the checker, and a checker bug is the panel's (g1 26.10: `tests-cli delivery` ×4, `run:` added thrice — the
// panel's LOOSE_RUN_REF missed the UUID tests-cli printed itself). RERUN stays silent there: the edits move editSeq.
const VERDICT_RE = /tests-cli\.mjs\s+(?:delivery|gaps|report|lint)\b/i;
const EVIDENCE_RE = /\.(?:md|txt)$|(?:^|\/)\.agent\//i;
export const LOOP_RUNS = 3;
// A segment whose program only reads (files, output, git state) runs no check, whatever words its arguments carry.
const READERS = new Set([
  'sed', 'cat', 'ls', 'dir', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'head', 'tail', 'less', 'more', 'wc', 'find', 'fd',
  'echo', 'printf', 'awk', 'gawk', 'cut', 'sort', 'uniq', 'diff', 'cmp', 'git', 'jq', 'yq', 'tee', 'nl', 'tr', 'od',
  'strings', 'column', 'stat', 'file', 'du', 'which', 'type', 'basename', 'dirname', 'realpath', 'readlink', 'test',
  '[', 'true', 'false', 'select-string', 'get-content', 'findstr',
]);
// Shell segments on && || ; | & and newlines, quotes respected; `2>&1`, `>&2`, `&>` are redirections, not a split.
function segments(c) {
  const out = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (q) {
      if (ch === q) q = '';
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
      continue;
    }
    const redir = ch === '&' && (c[i - 1] === '>' || c[i + 1] === '>');
    if (ch === '\n' || ch === ';' || ch === '|' || (ch === '&' && !redir)) {
      if (c[i + 1] === ch && ch !== '\n' && ch !== ';') i++;
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
const ENV_PREFIX = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/;
const WRAP_PREFIX = /^\s*(?:timeout\s+\S+\s+|npx\s+|pnpm\s+exec\s+|node\s+)/;
const headOf = (part) => {
  const w = part.replace(ENV_PREFIX, '').replace(/^\s*(?:sudo|command|exec|time|nohup)\s+/, '').trim().split(/\s+/)[0] ?? '';
  return w.replace(/^["'(]+|["')]+$/g, '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
};
// A heredoc body is data written somewhere (an edit script, a file), never a command: a `vitest` in it runs nothing.
// Only its opening line stays (g9 26.10 #g9:102: an edit script quoting a vitest import read as a check → false GAP).
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const dropHeredocs = (c) => c.replace(HEREDOC, (m) => m.slice(0, m.indexOf('\n')));
// Same check, other spelling: cd prefix, env assignments, timeout wrappers, output plumbing and redirections
// never change what the check judges.
export function checkKey(cmd) {
  const c = dropHeredocs(String(cmd ?? ''));
  if (!CHECK_TOKEN.test(c)) return null;
  const core = segments(c)
    .filter((part) => !/^\s*(?:cd|pushd|export|set)\s/.test(part) && !READERS.has(headOf(part)) && CHECK_TOKEN.test(part))
    .map((part) =>
      part
        .replace(/\s*(?:\d?>>?|&>)\s*\S+/g, '')
        .replace(/\s*\|\s*(?:tail|head|grep|tee|cat|less|sed|awk|cut|sort|uniq|wc)\b[^|]*/g, '')
        .replace(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '')
        .replace(WRAP_PREFIX, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .join(' && ');
  return core || null;
}
const lineCount = (s) => (s ? String(s).split('\n').length : 0);

const resultText = (c) =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((p) => (p?.type === 'text' ? p.text : p?.type === 'image' ? '[image]' : '')).join('\n')
      : '';
const firstLine = (c) => String(Array.isArray(c) ? c[0] : c ?? '').split('\n').find((l) => l.trim()) ?? '';

// IDE diagnostics on a copy the IDE's TS server does not own: «Cannot find module '@x/y'» for an alias the file's
// own tsconfig maps onto an existing path is the IDE's resolver, not the code (#g5:363, #g5:389 27.10, both false;
// the copy's tsc was green). Only `paths` of tsconfig.json / tsconfig.app.json up the tree; `extends` is not followed,
// so an unresolved case stays a real DIAG.
const diagFile = (uri) => {
  const s = String(uri ?? '');
  if (!s.startsWith('file:')) return s;
  try {
    return decodeURIComponent(new URL(s).pathname).replace(/^\/([a-zA-Z]:)/, '$1');
  } catch {
    return s;
  }
};
const looseJson = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(
      text
        .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str) => str ?? '')
        .replace(/,(\s*[}\]])/g, '$1'),
    );
  } catch {
    return null;
  }
};
const TS_TAILS = ['', '.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx'];
export function aliasResolves(uri, spec) {
  if (!spec || spec.startsWith('.')) return false;
  let dir = path.dirname(diagFile(uri));
  for (let depth = 0; depth < 12; depth++) {
    for (const name of ['tsconfig.json', 'tsconfig.app.json']) {
      const opts = looseJson(path.join(dir, name))?.compilerOptions;
      for (const [key, targets] of Object.entries(opts?.paths ?? {})) {
        const star = key.endsWith('/*');
        const head = star ? key.slice(0, -1) : key;
        if (star ? !spec.startsWith(head) : spec !== key) continue;
        const rest = star ? spec.slice(head.length) : '';
        for (const target of [].concat(targets)) {
          const at = path.resolve(dir, opts.baseUrl ?? '.', String(target).replace('*', rest));
          if (TS_TAILS.some((tail) => fs.existsSync(at + tail))) return true;
        }
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

function errLine(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const code = /^Exit code (\d+)/.exec(lines[0] ?? '')?.[1];
  const rest = code ? lines.slice(1) : lines;
  const pick = rest.find((l) => ERR_LINE.test(l)) ?? rest[0] ?? lines[0] ?? '';
  return `${code ? `exit ${code}: ` : ''}${one(pick, 150)}`;
}

// ---- state -------------------------------------------------------------------------------------------------
export function loadState(dir) {
  const f = path.join(dir, 'watch-state.json');
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (s && s.v === 1) return s;
  } catch {
    /* fresh */
  }
  return { v: 1, units: {}, files: {}, refs: {}, unknown: {}, plugin: {} };
}
export function saveState(dir, s) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'watch-state.json');
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s));
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, f);
      return;
    } catch (e) {
      if (i >= 4) throw e;
      const until = Date.now() + 120;
      while (Date.now() < until);
    }
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
export function takeLock(dir, holdSec) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'watch.lock');
  try {
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (cur.pid !== process.pid && pidAlive(cur.pid) && Date.now() - cur.at < (holdSec + 120) * 1000)
      return `locked by pid ${cur.pid} since ${hms(cur.at)} — another watch call is running on this state`;
  } catch {
    /* free or stale */
  }
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const free = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(f);
    } catch {
      /* gone */
    }
  };
  process.once('exit', free);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'])
    process.once(sig, () => {
      free();
      process.exit(130);
    });
  return null;
}

// ---- units -------------------------------------------------------------------------------------------------
export function parseUnitSpec(spec) {
  const m = /^([A-Za-z0-9_.-]+)=(dir|cwd|file|session|log):(.+)$/.exec(spec);
  if (!m) return null;
  return { name: m[1], kind: m[2], target: m[2] === 'session' ? m[3] : nativePath(m[3]) };
}
function peekCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, n).toString('utf8'));
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch {
    return null;
  }
}
function findProjectDir(root, cwd) {
  const pd = path.join(root, 'projects');
  const slug = slugOf(cwd);
  if (fs.existsSync(path.join(pd, slug))) return path.join(pd, slug);
  try {
    const hit = fs.readdirSync(pd).find((d) => d.toLowerCase() === slug.toLowerCase());
    return hit ? path.join(pd, hit) : null;
  } catch {
    return null;
  }
}
function findSession(root, id) {
  const pd = path.join(root, 'projects');
  try {
    for (const d of fs.readdirSync(pd)) {
      const f = path.join(pd, d, `${id}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {
    /* none */
  }
  return null;
}
// Resolves a unit to its transcript dir / file once found; returns the files to read now.
export function discover(u, opts) {
  const root = configRoot(opts);
  if (u.kind === 'none') return []; // status-only unit (a plugin watches it, no transcript)
  if (u.kind === 'foreign') {
    // Another CLI's session files, mapped to Claude records by foreign.mjs; none mapped = status-only.
    try {
      return foreignFiles(u, opts) ?? [];
    } catch {
      return [];
    }
  }
  // nativePath here too: a state saved before the spec was normalised heals on its next call.
  if (u.kind === 'log') return [{ f: path.resolve(nativePath(u.target)), role: 'log' }];
  if (u.kind === 'cwd' && !u.dir) u.dir = findProjectDir(root, nativePath(u.target));
  if (u.kind === 'session' && !u.file) u.file = findSession(root, u.target);
  if (u.kind === 'dir') u.dir = path.resolve(nativePath(u.target));
  if (u.kind === 'file') u.file = path.resolve(nativePath(u.target));
  const out = [];
  const subsOf = (sdir, sid) => {
    const d = path.join(sdir, 'subagents');
    let names;
    try {
      names = fs.readdirSync(d).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return;
    }
    for (const n of names) out.push({ f: path.join(d, n), role: 'sub', sid, agent: n.replace(/^agent-|\.jsonl$/g, '') });
  };
  if (u.dir && fs.existsSync(u.dir)) {
    for (const e of fs.readdirSync(u.dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push({ f: path.join(u.dir, e.name), role: 'main', sid: e.name.slice(0, -6) });
      else if (e.isDirectory()) subsOf(path.join(u.dir, e.name), e.name);
    }
  } else if (u.file && fs.existsSync(u.file)) {
    out.push({ f: u.file, role: 'main', sid: path.basename(u.file, '.jsonl') });
    subsOf(u.file.replace(/\.jsonl$/, ''), path.basename(u.file, '.jsonl'));
  }
  if (!u.cwd) {
    if (u.kind === 'cwd') u.cwd = nativePath(u.target);
    else {
      const newest = out.filter((x) => x.role === 'main').map((x) => ({ x, t: mtime(x.f) })).sort((a, b) => b.t - a.t)[0];
      if (newest) u.cwd = peekCwd(newest.x.f);
    }
  }
  return out;
}
const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

// ---- the reader --------------------------------------------------------------------------------------------
function newFileState(unit, d) {
  return {
    unit, role: d.role, sid: d.sid ?? null, agent: d.agent ?? null, offset: 0, lastAt: 0, grewAt: 0,
    open: {}, bg: {}, subs: {}, ctx: 0, ctxTop: [], msgIds: [], model: null, turnEnded: false, endedAt: 0,
    reads: {}, cmds: {}, enq: [], notified: [], firstUser: false, fromZero: false, desc: null,
    fmt: d.fmt ?? null, whole: !!d.whole, wholeN: 0, wholeSig: '',
    // editSeq moves on every tree change: a check whose key last ran at the same editSeq re-ran on the same tree.
    editSeq: 0, checks: {}, fails: {}, waste: {}, burned: {}, turnAt: 0, turnTok: 0, turnOut: 0,
  };
}
const capMap = (m, n) => {
  const k = Object.keys(m);
  if (k.length > n) for (const x of k.slice(0, k.length - n / 2)) delete m[x];
};

export class Watcher {
  constructor(state, opts) {
    this.s = state;
    this.o = opts;
    this.events = [];
    this.backlog = [];
    this.now = Date.now();
    this.bytes = 0;
    this.parseFlag = new Set();
    // Token spend per unit over the messages read by THIS call (economy is watched like a bug, owner 25.10).
    this.spent = {};
    // Checks that finished in this call: a plugin joins them to its own feed (agentdeck: the verify-ledger).
    this.checkRuns = [];
    // REPEAT / RERUN candidates of this pass, judged once every file of the unit was read.
    this.pending = [];
    // Offsets as this call found them: everything past them was read after the call began — a lower bound for a
    // mark stamped at an event this call sees (mark()).
    this.startOff = Object.fromEntries(Object.entries(state.files ?? {}).map(([f, st]) => [f, st.offset]));
    // The newest record each file had at this call's start: a file already read past an event has no lower bound
    // at its start offset (the panel can name a stage start the earlier calls already read past).
    this.startLast = Object.fromEntries(Object.entries(state.files ?? {}).map(([f, st]) => [f, st.lastAt ?? 0]));
    // Stage reader of a plugin: (first prompt text, file state) → mark name or null (convMark()).
    this.convName = null;
  }
  // A tree change anywhere in the unit (main or subagent): its time, so a later identical check is judged right.
  // The file, when known, lets a plugin attribute a side effect (a dev-server restart) to the unit that caused it.
  edited(unit, at, file) {
    const u = this.s.units[unit];
    if (!u) return;
    const list = (u.editAt ??= []);
    list.push(at);
    if (list.length > 100) list.splice(0, list.length - 100);
    if (!file) return;
    const files = (u.editFiles ??= []);
    files.push({ f: normP(file), at });
    if (files.length > 100) files.splice(0, files.length - 100);
  }
  flushRepeats() {
    for (const p of this.pending.splice(0)) {
      const edits = this.s.units[p.st.unit]?.editAt ?? [];
      if (edits.some((t) => t > p.prevAt && t <= p.at)) continue;
      if (p.kind === 'rerun')
        this.waste(this.emit(p.st.unit, 'hi', 'RERUN', `${one(p.ck, 120)} again with no edit since its run ${age(p.at - p.prevAt)} ago — same tree, same verdict`, p.at, p.loc), p.st, 'rerun', p.at, p.loc);
      else this.waste(this.emit(p.st.unit, 'mid', 'REPEAT', `×${p.n} ${p.b}`, p.at, p.loc), p.st, 'repeat', p.at, p.loc);
    }
  }
  // One waste occurrence. Every waste flag carries `waste` (a plugin arms a safe-point pause on it); the same burn
  // class twice inside one turn raises BURN once — the loop is running now, waiting for the turn end is the cost.
  waste(ev, st, cls, at, loc) {
    if (!ev) return ev;
    ev.waste = cls;
    const n = (st.waste[cls] = (st.waste[cls] ?? 0) + 1);
    if (WASTE_BURN.has(cls) && n >= 2 && !st.burned[cls]) {
      st.burned[cls] = true;
      const b = this.emit(st.unit, 'hi', 'BURN', `${cls} ×${n} in one turn — the loop runs now: pause, fix the cause, resume`, at, loc);
      b.waste = cls;
      b.burn = true;
    }
    return ev;
  }
  // Byte offsets of every file of a unit, named: show.mjs --pack reads the stretch between two marks.
  // Without `at` the mark is now (setup, ended). With `at` it is an EVENT already past — a stage's start, a new
  // conversation's first record — stamped at the event, not at the wake that saw it (g5 25.10: stage:fix stamped
  // 6m17s late, its first edits fell into the review pack). Then `off` is a lower bound (offsets at this call's
  // start, read before the event was seen; 0 when an earlier call already read past the event), and show.mjs cuts
  // by the records' own timestamps (`ev`). `end` only names the files known at the mark: in a catch-up pass a file
  // not yet read in this call sits at its old offset (g9 26.10: a 9-hour gap replayed at once, the review pack cut
  // ef195059 at 04:08, 1 h before the stage ended) — show.mjs reads an `ev` stretch to the file's current end.
  // A file born at the event (`born`, or first record at/after it) belongs wholly to what follows: offset 0 in
  // `off`, absent from `end` — a pack ending at this mark skips it.
  mark(unit, name, { at, born = [], conv } = {}) {
    const t = at ?? Date.now();
    const off = {};
    const end = {};
    for (const [f, st] of Object.entries(this.s.files)) {
      if (st.unit !== unit || st.role === 'log') continue;
      if (at !== undefined && (born.includes(f) || (st.bornLive && st.firstAt >= t - BORN_SLACK_MS))) {
        off[f] = 0;
        continue;
      }
      // A file first seen in this call was read from 0 (fromZero) — all of it is after the lower bound.
      off[f] = at === undefined ? st.offset : (this.startLast[f] ?? 0) > t ? 0 : Math.min(this.startOff[f] ?? (st.fromZero ? 0 : st.offset), st.offset);
      end[f] = st.offset;
    }
    const list = ((this.s.marks ??= {})[unit] ??= []);
    const m = { name, at: t, off };
    if (at !== undefined) Object.assign(m, { end, ev: true, stampedAt: Date.now() });
    if (conv) m.conv = conv;
    list.push(m);
    if (list.length > T.marks) list.splice(0, list.length - T.marks);
    return m;
  }
  // A main conversation born while the watch runs gets its mark at its first record (W4: the verify session of g5
  // got none). The name comes from its brief (convName, a plugin's stage reader), else conv:<sid8>.
  convMark(st, text, loc) {
    if (st.role !== 'main' || !st.bornLive || !st.sid) return;
    const list = this.s.marks?.[st.unit] ?? [];
    if (list.some((m) => m.conv === st.sid)) return;
    let name = null;
    try {
      name = this.convName?.(text, st) ?? null;
    } catch {
      /* a broken namer must not cost the mark */
    }
    const at = st.firstAt ?? this.now;
    // 26.10 g8 P10: the plugin's STAGE mark came first (stage:review 19:08:33Z), the conversation's mark 29 min later
    // named the same start (19:08:31Z) — two marks, a pack bounded by the name took either. A same-name mark without a
    // conversation, this close, IS this start: adopted — the earlier time, the new file wholly after it.
    const twin = name && list.find((m) => !m.conv && m.name === name && Math.abs(m.at - at) <= ADOPT_MS);
    if (twin) {
      Object.assign(twin, { conv: st.sid, at: Math.min(twin.at, at) });
      twin.off[loc.f] = 0;
      if (twin.end) delete twin.end[loc.f];
      return;
    }
    this.mark(st.unit, name || `conv:${st.sid.slice(0, 8)}`, { at, born: [loc.f], conv: st.sid });
  }
  // Every flag gets a ref, a row cites it (keepalive.mjs). A flag with no transcript record behind it (STALL, a
  // plugin's STORM or GAP) keeps its text in the ring instead of a byte range. `at` = the flag's own record time: a
  // replay of hours stamped every ref with the wake (g9 26.10: 600 refs at 13:16), a stage's flags lost their stage.
  ref(unit, loc, tag, text, at) {
    const r = (this.s.refs[unit] ??= { n: 0, ring: [] });
    r.n += 1;
    const t = at || this.now;
    r.ring.push(loc ? { n: r.n, f: loc.f, off: loc.off, len: loc.len, idx: loc.idx, tag, at: t } : { n: r.n, f: null, tag, at: t, text: one(text, 600) });
    if (r.ring.length > T.ring) r.ring.splice(0, r.ring.length - T.ring);
    return `#${unit}:${r.n}`;
  }
  emit(unit, sev, tag, text, at, loc, sink) {
    const ev = { unit, sev, tag, text, at: at || this.now, ref: sev === 'lo' ? '' : this.ref(unit, loc, tag, text, at) };
    // The transcript the flag came from: a plugin judges whether its conversation still runs (lib/pauses.mjs).
    if (loc?.f) ev.f = loc.f;
    // The tool call the flag was read from: a late burn whose call already returned no longer cuts it (lib/pauses.mjs).
    if (loc?.call) ev.call = loc.call;
    (sink ?? this.sink ?? this.events).push(ev);
    return ev;
  }
  rel(unit, p) {
    if (!p) return '';
    const cwd = this.s.units[unit]?.cwd;
    const abs = String(p);
    if (cwd && insideOf(abs, cwd)) return path.relative(cwd, abs).replace(/\\/g, '/') || '.';
    const home = os.homedir();
    return insideOf(abs, home) ? `~/${path.relative(home, abs).replace(/\\/g, '/')}` : abs.replace(/\\/g, '/');
  }

  // One pass over every unit: discover files, read new complete lines, run the heuristics.
  // `fresh` = units added by this call: their existing files are taken at the end (tail seeded); a file
  // discovered in any other unit is new work and is read from byte 0.
  pass(fresh) {
    this.now = Date.now();
    for (const [name, u] of Object.entries(this.s.units)) {
      const seedNew = fresh?.has(name);
      for (const d of discover(u, this.o)) {
        let st = this.s.files[d.f];
        // A state saved by an older script lacks the newer fields: filled, never reset.
        if (st) for (const [k, v] of Object.entries(newFileState(name, d))) if (st[k] === undefined) st[k] = v;
        if (!st) {
          st = this.s.files[d.f] = newFileState(name, d);
          if (d.role === 'sub') {
            try {
              st.desc = JSON.parse(fs.readFileSync(d.f.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description ?? null;
            } catch {
              /* no meta */
            }
          }
          if (seedNew && this.o.from !== 'start') this.seed(d.f, st);
          else {
            st.fromZero = true;
            // Born while the watch runs (not a file the unit started with): its first record dates it (convMark).
            if (!seedNew) st.bornLive = true;
            if (!seedNew && d.role === 'sub') this.emit(name, 'mid', 'SUB', `started ${one(st.desc ?? st.agent, 90)}`, this.now, null);
          }
        }
        this.read(d.f, st);
      }
    }
    this.flushRepeats();
  }
  seed(f, st) {
    let size;
    try {
      size = fs.statSync(f).size;
    } catch {
      return;
    }
    st.offset = size;
    st.firstUser = true;
    if (st.role === 'log') return;
    // The tail is read even for an hours-old file: without it the unit has no last time and no turn end, and
    // shows a paused group as «turn running» with a STALL counted from 1970. Its old flags go nowhere, not to
    // BACKLOG — they are history, not news.
    const stale = Date.now() - mtime(f) > T.seedFreshMs;
    if (st.whole) {
      this.sink = stale ? [] : this.backlog;
      this.readWhole(f, st, size, mtime(f));
      this.flushRepeats();
      this.sink = null;
      if (stale) st.open = {};
      return;
    }
    const from = Math.max(0, size - T.seedBytes);
    this.sink = stale ? [] : this.backlog;
    this.lines(f, st, from, size, from > 0);
    this.flushRepeats();
    this.sink = null;
    // A call still open in a file nobody wrote to for hours died with its turn (a pause, a crash): not OPEN.
    if (stale) st.open = {};
  }
  read(f, st) {
    let size;
    let mt;
    try {
      const stat = fs.statSync(f);
      size = stat.size;
      mt = stat.mtimeMs;
    } catch {
      return;
    }
    if (st.whole) return this.readWhole(f, st, size, mt);
    if (size < st.offset) {
      this.emit(st.unit, 'hi', 'RESET', `${path.basename(f)} shrank ${kc(st.offset)}B → ${kc(size)}B — re-read from 0`, this.now, null);
      Object.assign(st, { offset: 0, open: {}, reads: {}, cmds: {}, msgIds: [] });
    }
    if (size === st.offset) return;
    const used = this.lines(f, st, st.offset, size, false);
    if (used > 0) {
      st.offset += used;
      st.grewAt = this.now;
      this.bytes += used;
    }
  }
  // A foreign document rewritten in place: re-parsed whole when it moved, only records past wholeN are fed.
  readWhole(f, st, size, mt) {
    const sig = `${size}:${mt}`;
    if (sig === st.wholeSig) return;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return; // mid-write: the next pass
    }
    st.wholeSig = sig;
    let recs;
    try {
      recs = toClaude(st.fmt, doc, st) ?? [];
    } catch (e) {
      this.emit(st.unit, 'hi', 'PARSE', `${path.basename(f)} (${st.fmt}) mapper failed: ${one(e.message, 120)}`, this.now, null);
      return;
    }
    if (recs.length < st.wholeN) st.wholeN = 0;
    for (let i = st.wholeN; i < recs.length; i++) this.record(recs[i], { f, off: -1, len: 0, idx: i }, st);
    if (recs.length > st.wholeN) {
      st.grewAt = this.now;
      this.bytes += size;
    }
    st.wholeN = recs.length;
    st.offset = size;
  }
  // Reads [from, to) and handles complete lines only; returns bytes consumed.
  lines(f, st, from, to, skipFirst) {
    let len = Math.min(to - from, T.chunkBytes);
    let buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    try {
      fs.readSync(fd, buf, 0, len, from);
      if (buf.lastIndexOf(0x0a) < 0 && len === T.chunkBytes && to - from > len) {
        len = Math.min(to - from, 64 * 1024 * 1024);
        buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, from);
      }
    } finally {
      fs.closeSync(fd);
    }
    const last = buf.lastIndexOf(0x0a);
    if (last < 0) return 0;
    let start = 0;
    if (skipFirst) start = buf.indexOf(0x0a) + 1;
    const logLines = [];
    while (start <= last) {
      const nl = buf.indexOf(0x0a, start);
      const loc = { f, off: from + start, len: nl - start };
      const text = buf.subarray(start, nl).toString('utf8').trim();
      start = nl + 1;
      if (!text) continue;
      if (st.role === 'log') {
        logLines.push({ text, loc });
        continue;
      }
      let r;
      try {
        r = JSON.parse(text);
      } catch {
        if (!this.parseFlag.has(f)) {
          this.parseFlag.add(f);
          this.emit(st.unit, 'hi', 'PARSE', `${path.basename(f)} line @${loc.off} is not JSON: ${one(text, 80)}`, this.now, loc);
        }
        continue;
      }
      if (st.fmt) {
        let recs = [];
        try {
          recs = toClaude(st.fmt, r, st) ?? [];
        } catch (e) {
          if (!this.parseFlag.has(f)) {
            this.parseFlag.add(f);
            this.emit(st.unit, 'hi', 'PARSE', `${path.basename(f)} (${st.fmt}) mapper failed: ${one(e.message, 120)}`, this.now, loc);
          }
        }
        for (const c of recs) this.record(c, loc, st);
        continue;
      }
      this.record(r, loc, st);
    }
    if (logLines.length) this.logs(st, logLines);
    return last + 1;
  }
  logs(st, lines) {
    const plain = [];
    for (const l of lines) {
      if (ERR_LINE.test(l.text.replace(ZERO_COUNT, ''))) this.emit(st.unit, 'hi', 'LOG!', one(l.text, 200), this.now, l.loc);
      else plain.push(l);
    }
    // Every plain line is shown (owner 25.10: every action seen, nothing collapsed): the last 5 as mid, the rest as
    // routine lines — never a «N more lines» count.
    for (const [n, l] of plain.entries()) {
      this.emit(st.unit, n >= plain.length - 5 ? 'mid' : 'lo', 'LOG', one(l.text, 200), this.now, l.loc);
    }
  }

  record(r, loc, st) {
    const at = Date.parse(r.timestamp) || this.now;
    if (st.bornLive && st.firstAt === undefined && Number.isFinite(Date.parse(r.timestamp))) st.firstAt = at;
    const u = st.unit;
    const unit = this.s.units[u];
    if (unit && !unit.cwd && r.cwd) unit.cwd = r.cwd;
    if (SKIP_TYPES.has(r.type)) return;
    if (!KNOWN_TYPES.has(r.type)) {
      if (!this.s.unknown[r.type]) {
        this.s.unknown[r.type] = at;
        this.emit(u, 'hi', 'UNKNOWN', `record type "${r.type}" — the CLI format moved, the parser needs a look`, at, loc);
      }
      return;
    }
    st.lastAt = Math.max(st.lastAt, at);
    if (r.type === 'assistant') this.assistant(r, loc, st, at);
    else if (r.type === 'user') this.user(r, loc, st, at);
    else if (r.type === 'system') this.system(r, loc, st, at);
    else if (r.type === 'attachment') this.attachment(r, loc, st, at);
    else if (r.type === 'queue-operation' && r.operation === 'enqueue' && typeof r.content === 'string')
      this.prompt(r.content, loc, st, at, 'queued');
  }

  assistant(r, loc, st, at) {
    const u = st.unit;
    const m = r.message ?? {};
    const content = Array.isArray(m.content) ? m.content : [];
    st.turnEnded = false;
    const fresh = m.id && !st.msgIds.includes(m.id);
    if (fresh) {
      st.msgIds.push(m.id);
      if (st.msgIds.length > 40) st.msgIds.shift();
      const us = m.usage;
      if (us && m.model !== '<synthetic>') {
        const ctx = (us.input_tokens ?? 0) + (us.cache_read_input_tokens ?? 0) + (us.cache_creation_input_tokens ?? 0);
        const sp = (this.spent[u] ??= { msgs: 0, out: 0, write: 0, read: 0 });
        sp.msgs += 1;
        sp.out += us.output_tokens ?? 0;
        sp.write += (us.input_tokens ?? 0) + (us.cache_creation_input_tokens ?? 0);
        sp.read += us.cache_read_input_tokens ?? 0;
        // The turn's own bill, printed on its END line: every turn is judged by what it cost, no threshold.
        st.turnOut += us.output_tokens ?? 0;
        st.turnTok += ctx + (us.output_tokens ?? 0);
        const d = ctx - st.ctx;
        // The first message after a compaction re-counts the baseline (system, tools, summary) — +30–44k measured
        // 25.10 on every resume, never a step's cost. Only that one message is skipped; the next jump flags again.
        const resumed = st.postCompact;
        st.postCompact = false;
        if (st.ctx && d >= T.ctxJump && !resumed) {
          const cause = st.lastResult;
          const ev = this.waste(this.emit(u, 'mid', 'CTX+', `+${kc(d)} → ${kc(ctx)}${cause ? ` after ${cause.b}` : ''}`, at, cause?.loc ?? loc), st, 'ctx', at, loc);
          st.ctxTop.push({ d, ctx, at, ref: ev.ref, cause: cause?.b ?? '' });
          st.ctxTop.sort((a, b) => b.d - a.d).splice(8);
        }
        if (ctx >= T.ctxHigh && !st.ctxHiAt) {
          st.ctxHiAt = at;
          this.emit(u, 'mid', 'CTXHI', `context ${kc(ctx)} ≥ ${kc(T.ctxHigh)} — compaction near`, at, loc);
        }
        st.ctx = ctx;
      }
      if (m.model && m.model !== '<synthetic>') {
        if (st.model && st.model !== m.model) this.emit(u, 'mid', 'MODEL', `${m.model} (was ${st.model})`, at, loc);
        st.model = m.model;
      }
    }
    const text = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    if (r.isApiErrorMessage || (m.model === '<synthetic>' && /limit|error|overloaded|unavailable/i.test(text))) {
      // «You've hit your session limit» arrives as error 'rate_limit' — ~90 of them were tagged APIERR.
      const tag = r.error === 'rate_limit' || /usage limit|rate limit|session limit|limit reached|5-hour|weekly limit|\b429\b/i.test(text) ? 'LIMIT' : 'APIERR';
      this.emit(u, 'hi', tag, one(text || r.error, 180), at, loc);
    }
    for (const p of content) if (p.type === 'tool_use') this.toolUse(p, loc, st, at);
    if (text && !st.wordIds?.includes(m.id)) {
      // Code spans are quotes — a log line, a command — not the agent's own words (g1 26.10 #g1:137: «not run» in
      // `prepare_script could not run to completion`). Blanked to the same length, so the excerpt stays the text.
      const w = WORD_RE.exec(text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (q) => ' '.repeat(q.length)));
      if (w) {
        st.wordIds = [...(st.wordIds ?? []).slice(-20), m.id];
        const i = w.index;
        this.emit(u, 'mid', 'WORD', `«${w[0].trim()}»: …${one(text.slice(Math.max(0, i - 70), i + 90), 170)}…`, at, loc);
      }
    }
    if (m.stop_reason === 'end_turn') {
      st.turnEnded = true;
      st.endedAt = at;
      if (text && st.endedId !== m.id) {
        st.endedId = m.id;
        const bill = st.turnAt ? `(turn ${age(at - st.turnAt)} · ${kc(st.turnTok)} tok · out ${kc(st.turnOut)}) ` : '';
        if (st.role === 'main') this.emit(u, 'hi', 'END', `${bill}${one(text, 260)}`, at, loc);
        else this.emit(u, 'mid', 'SUB', `done ${one(st.desc ?? st.agent, 60)}: ${one(text, 140)}`, at, loc);
      }
    }
  }

  toolUse(p, loc, st, at) {
    loc = loc && { ...loc, call: p.id };
    const u = st.unit;
    const i = p.input ?? {};
    const b = this.brief(u, p.name, i);
    const op = (st.open[p.id] = { name: p.name, at, b, bg: !!i.run_in_background, timeout: i.timeout ?? null, key: null });
    // The call itself, not just its tool name: the watcher reads every action (owner 25.10). An edit carries its
    // size, so a rewrite of a whole file or an edit far larger than its task shows in the action list itself.
    const size = ['Edit', 'MultiEdit'].includes(p.name)
      ? ` −${(i.edits ?? [i]).reduce((n, e) => n + lineCount(e.old_string), 0)}/+${(i.edits ?? [i]).reduce((n, e) => n + lineCount(e.new_string), 0)} lines${i.replace_all ? ' (all)' : ''}`
      : p.name === 'Write' ? ` ${lineCount(i.content)} lines (whole file)` : '';
    this.emit(u, 'lo', 'CALL', `${p.name} ${b ?? ''}${size}`.trim(), at, null);
    if (p.name === 'Bash') {
      const cmd = String(i.command ?? '');
      if (sleepWaits(cmd) && !probeLoop(cmd)) {
        // Only a flag in the persisted state; the event itself is kept for this wake (state stays small).
        op.sleep = 1;
        (this.sleepEvs ??= new Map()).set(p.id, this.waste(this.emit(u, 'mid', 'SLEEP', b, at, loc), st, 'sleep', at, loc));
      }
      const k = `b:${one(cmd, 400)}`;
      op.key = k;
      const c = st.cmds[k];
      // A check re-run on the tree it already judged, spelled any way: hi (RERUN replaces REPEAT), because its whole
      // cost is waste — the same tree gives the same verdict.
      const ck = checkKey(cmd);
      const prev = ck ? st.checks[ck] : null;
      // Judged after the pass (flushRepeats): an edit by a subagent of the same unit, read later in the same pass,
      // changes the tree too.
      if (prev && prev.seq === st.editSeq && !prev.denied) this.pending.push({ kind: 'rerun', st, ck, b, prevAt: prev.at, at, loc });
      else if (c && !c.denied) this.pending.push({ kind: 'repeat', st, b, n: c.n + 1, prevAt: c.at ?? 0, at, loc });
      st.cmds[k] = { n: (c?.n ?? 0) + 1, denied: false, at };
      const vk = ck ?? (VERDICT_RE.test(cmd) ? one(cmd.replace(/\s+/g, ' '), 200) : null);
      if (vk) {
        const runs = ((st.turnRuns ??= {})[vk] ??= []);
        runs.push(at);
        capMap(st.turnRuns, 50);
        const between = (this.s.units[u]?.editFiles ?? []).filter((e) => e.at > runs[0] && e.at <= at);
        if (runs.length >= LOOP_RUNS && !(st.loopSeen ??= {})[vk] && between.length && between.every((e) => EVIDENCE_RE.test(e.f.replace(/\\/g, '/')))) {
          st.loopSeen[vk] = true;
          this.emit(u, 'mid', 'CHECKER-LOOP', `${one(vk, 100)} ×${runs.length} in one turn, edits between only to ${[...new Set(between.map((e) => this.rel(u, e.f)))].join(', ')} — arguing with the checker: read the checker's own rule (a bug there is the panel's)`, at, loc);
        }
      }
      if (ck) {
        op.check = ck;
        st.checks[ck] = { seq: st.editSeq, at, denied: false };
        capMap(st.checks, 200);
      }
      if (TREE_RE.test(cmd)) {
        st.reads = {};
        st.cmds = { [k]: st.cmds[k] };
        st.editSeq += 1;
        this.edited(u, at);
      }
      capMap(st.cmds, 300);
    } else if (p.name === 'Read' && i.file_path) {
      const k = `r:${normP(i.file_path)}#${i.offset ?? 0}:${i.limit ?? ''}${i.pages ? `:${i.pages}` : ''}`;
      op.key = k;
      const c = st.reads[k];
      if (c && !c.denied) this.waste(this.emit(u, 'mid', 'REREAD', `×${c.n + 1} ${b} (unchanged since the last read)`, at, loc), st, 'reread', at, loc);
      st.reads[k] = { n: (c?.n ?? 0) + 1, denied: false };
      capMap(st.reads, 300);
    } else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(p.name)) {
      const pre = `r:${normP(i.file_path ?? i.notebook_path ?? '')}#`;
      for (const k of Object.keys(st.reads)) if (k.startsWith(pre)) delete st.reads[k];
      st.cmds = {};
      st.editSeq += 1;
      this.edited(u, at, i.file_path ?? i.notebook_path);
    } else if (p.name === 'Agent' || p.name === 'Task') {
      this.emit(u, 'mid', 'SPAWN', b, at, loc);
    } else if (p.name === 'AskUserQuestion') {
      this.emit(u, 'hi', 'ASK', b, at, loc);
    }
  }
  brief(u, name, i) {
    switch (name) {
      case 'Bash': {
        // A chain whose checks sit past the cut reads as its head (#g5:390 27.10: a 10-min gate chain shown as
        // `grep -rln …`) — the checks it runs are named first, so a cut line keeps them.
        const shown = one(i.command, 110);
        const checks = checkKey(i.command);
        const hidden = checks && !shown.includes(checks.split(' && ')[0].slice(0, 40)) ? `[runs ${one(checks, 90)}] ` : '';
        return `${hidden}'${shown}'${i.run_in_background ? ' [bg]' : ''}`;
      }
      case 'Read':
        return this.rel(u, i.file_path) + (i.offset || i.limit ? `#${i.offset ?? 0}:${i.limit ?? ''}` : '');
      case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
        return this.rel(u, i.file_path ?? i.notebook_path);
      case 'Grep':
        return one(`/${i.pattern}/ ${i.path ? this.rel(u, i.path) : ''} ${i.glob ?? ''}`, 110);
      case 'Glob':
        return one(i.pattern, 80);
      case 'Agent': case 'Task':
        return one(`${i.description ?? ''} · ${i.subagent_type ?? 'general'}${i.model ? ` · ${i.model}` : ''}${i.run_in_background ? ' · bg' : ''}`, 120);
      case 'Skill':
        return one(i.skill ?? i.command, 60);
      case 'AskUserQuestion':
        return one(i.questions?.[0]?.question ?? i.question, 160);
      default:
        return one(JSON.stringify(i), 90);
    }
  }

  user(r, loc, st, at) {
    const c = r.message?.content;
    if (Array.isArray(c)) {
      for (const p of c) {
        if (p?.type === 'tool_result') {
          st.turnEnded = false;
          this.toolResult(p, r, loc, st, at);
        } else if (p?.type === 'text' && p.text) this.userText(p.text, r, loc, st, at);
      }
    } else if (typeof c === 'string') this.userText(c, r, loc, st, at);
  }
  userText(text, r, loc, st, at) {
    if (r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) return;
    const t = text.trim();
    if (/^<(?:local-command|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr)/.test(t)) return;
    if (/<task-notification>/.test(t)) return this.notification(t, loc, st, at);
    if (/^\[Request interrupted by user/.test(t)) return void this.emit(st.unit, 'hi', 'INTR', one(t, 100), at, loc);
    this.prompt(t, loc, st, at, 'user');
  }
  // A prompt reaching the agent: the first one of a fresh file is the brief (NEWCONV), later ones were injected.
  prompt(text, loc, st, at, via) {
    if (/<task-notification>/.test(text)) return this.notification(text, loc, st, at);
    st.turnEnded = false;
    const h = hash(text);
    if (st.enq.includes(h)) return;
    st.enq = [...st.enq.slice(-12), h];
    // A prompt opens a turn: its bill and its waste counters start from zero.
    Object.assign(st, { turnAt: at, turnTok: 0, turnOut: 0, waste: {}, burned: {}, turnRuns: {}, loopSeen: {} });
    const u = st.unit;
    const size = `${kc(text.length)} chars`;
    if (!st.firstUser) {
      st.firstUser = true;
      if (st.role === 'sub') return;
      this.convMark(st, text, loc);
      this.emit(u, 'hi', 'NEWCONV', `${(st.sid ?? '').slice(0, 8)} first prompt ${size}: ${one(text, 170)}`, at, loc);
    } else this.emit(u, 'hi', 'INJECT', `${via} ${size}: ${one(text, 190)}`, at, loc);
    if (text.length > T.briefChars) this.emit(u, 'hi', 'BRIEF', `${size} prompt — read it by ref, judge whether it needs to be this long`, at, loc);
  }
  notification(text, loc, st, at) {
    const id = /<task-id>([^<]+)</.exec(text)?.[1] ?? '?';
    const status = /<status>([^<]+)</.exec(text)?.[1] ?? '';
    const key = `${id}:${status}`;
    if (st.notified.includes(key)) return;
    st.notified = [...st.notified.slice(-30), key];
    const was = st.bg[id] ?? st.subs[id];
    delete st.bg[id];
    delete st.subs[id];
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? '';
    const sev = /killed|fail|error|timeout|stopped/i.test(status) ? 'hi' : 'mid';
    this.emit(st.unit, sev, 'BGDONE', `${id} ${status || '?'}${was ? ` ${one(was.b, 70)}` : ''}: ${one(summary, 140)}`, at, loc);
  }
  toolResult(p, r, loc, st, at) {
    loc = loc && { ...loc, call: p.tool_use_id };
    const u = st.unit;
    const op = st.open[p.tool_use_id];
    delete st.open[p.tool_use_id];
    const name = op?.name ?? 'tool';
    const b = op?.b ?? '';
    const text = resultText(p.content);
    const tur = r.toolUseResult && typeof r.toolUseResult === 'object' && !Array.isArray(r.toolUseResult) ? r.toolUseResult : {};
    st.lastResult = { b: `${name} ${one(b, 70)}`, loc };
    const head = text.slice(0, 600);
    if (r.toolDenialKind || r.permissionDecision?.decision === 'reject' || DENY_RE.test(head)) {
      const g =
        /\[ctx-guard\]\s*([\w-]+)/.exec(head)?.[1] ??
        /hook error:\s*\[([^\]]+)\]/.exec(head)?.[1] ??
        r.permissionDecision?.source ??
        r.toolDenialKind ??
        'permission';
      const reason = head.replace(/^.*?(?:\[ctx-guard\]\s*[\w-]+|hook error:\s*\[[^\]]+\])\s*/s, '');
      if (op?.key) {
        const map = op.key.startsWith('r:') ? st.reads : st.cmds;
        if (map[op.key]) map[op.key].denied = true;
      }
      if (op?.check && st.checks[op.check]) st.checks[op.check].denied = true;
      // A denied call never ran: its sleep waited for nothing — the arm and the burn count go with it (g1 26.10:
      // a denied call + one 6-s probe counted «sleep ×2», BURN paused the group NOW).
      if (op?.sleep) {
        const ev = this.sleepEvs?.get(p.tool_use_id);
        if (ev?.waste === 'sleep') delete ev.waste;
        st.waste.sleep = Math.max(0, (st.waste.sleep ?? 1) - 1);
      }
      this.emit(u, 'hi', 'DENY', `${name} ${one(b, 90)} ← ${g}: ${one(reason, 150)}`, at, loc);
      return;
    }
    const cmd = op?.name === 'Bash' ? b.slice(1) : '';
    // A failed Read delivered nothing: the same range read again is the retry, not a re-read (#g5:102, 25.10).
    if (p.is_error && op?.key?.startsWith('r:') && st.reads[op.key]) st.reads[op.key].denied = true;
    if (tur.interrupted === true || /^\[Request interrupted by user/.test(text.trim()))
      this.emit(u, 'hi', 'INTR', `${name} ${one(b, 120)}`, at, loc);
    else if (TIMEOUT_RE.test(head) && (p.is_error || name === 'Bash'))
      this.emit(u, 'hi', 'TIMEOUT', `${name} ${one(b, 100)}: ${errLine(text)}`, at, loc);
    else if (p.is_error) {
      const benign = name === 'Bash' && /^Exit code 1\s*$/m.test(text.split('\n')[0]) && BENIGN_EXIT1.test(cmd) && text.trim().split('\n').length <= 2;
      if (!benign) {
        // The same call failing the same way again = retrying blind (a burn class): the cause was never read.
        const fk = `${name}|${one(b, 200)}|${errLine(text)}`;
        const again = st.fails[fk];
        st.fails[fk] = (again ?? 0) + 1;
        capMap(st.fails, 100);
        const ev = this.emit(u, 'hi', 'ERR', `${again ? `×${again + 1} same failure · ` : ''}${name} ${one(b, 80)}: ${errLine(text)}`, at, loc);
        if (again) this.waste(ev, st, 'err-repeat', at, loc);
      }
    }
    // A finished check: the plugin matches it to the legend's feed (a check the legend never saw is a row).
    if (op?.check && !op.bg) this.checkRuns.push({ unit: u, check: op.check, cmd: cmd || b, start: op.at, end: at, ref: '', loc, exit: p.is_error ? 1 : 0 });
    // A stopped task sends no notification: TaskStop / KillShell itself closes it, failed too (gone = not
    // running) — g8 26.10: a grep stopped 03:07 stayed «bg 1» and BGLONG 13 min later.
    if (['TaskStop', 'KillShell', 'KillBash'].includes(name)) {
      const stopped = /"(?:task_id|shell_id|bash_id)"\s*:\s*"([^"]+)"/.exec(b)?.[1];
      if (stopped) {
        delete st.bg[stopped];
        delete st.subs[stopped];
      }
    }
    if (tur.backgroundTaskId) {
      st.bg[tur.backgroundTaskId] = { b, at };
      this.emit(u, 'mid', 'BG', `${tur.backgroundTaskId} ${one(b, 110)}`, at, loc);
    }
    if (tur.agentId && /async/.test(String(tur.status ?? ''))) st.subs[tur.agentId] = { b, at };
    const dur = op ? at - op.at : 0;
    if (op && dur >= T.slowSec * 1000 && !op.bg && !['Agent', 'Task', 'AskUserQuestion'].includes(name))
      this.waste(this.emit(u, 'mid', 'SLOW', `${name} ${age(dur)} ${one(b, 100)}`, at, loc), st, 'slow', at, loc);
    const size = Number(tur.persistedOutputSize) || text.length;
    if (size >= T.bigChars || tur.persistedOutputPath)
      this.waste(this.emit(u, 'mid', 'BIG', `${name} ${kc(size)} chars${tur.persistedOutputPath ? ' (persisted to file)' : ''} ${one(b, 80)}`, at, loc), st, 'big', at, loc);
  }
  system(r, loc, st, at) {
    const u = st.unit;
    switch (r.subtype) {
      case 'compact_boundary': {
        const cm = r.compactMetadata ?? {};
        this.emit(u, 'hi', 'COMPACT', `${cm.trigger ?? ''} ${kc(cm.preTokens ?? 0)} → ${kc(cm.postTokens ?? 0)}`, at, loc);
        Object.assign(st, { reads: {}, cmds: {}, ctx: cm.postTokens ?? 0, ctxHiAt: 0, postCompact: true });
        break;
      }
      case 'stop_hook_summary':
        if (r.hookErrors?.length || r.preventedContinuation)
          this.emit(u, 'hi', 'HOOK', `Stop hooks: ${r.hookErrors?.length ?? 0} error(s)${r.preventedContinuation ? ', continuation prevented' : ''}: ${one(JSON.stringify(r.hookErrors ?? r.stopReason ?? ''), 170)}`, at, loc);
        break;
      case 'api_error': {
        const e = r.error ?? {};
        const n = r.retryAttempt ?? 0;
        if (n <= 1 || n >= (r.maxRetries ?? 10)) {
          // Status and the error's own words decide, never key names: every real record carries `rateLimits: null`,
          // and a JSON match tagged 291 upstream 502/529/ECONNRESET errors LIMIT («wait») instead of an error loop.
          const said = `${e.status ?? ''} ${e.message ?? ''} ${e.formatted ?? ''}`;
          const limit = e.status === 429 || (e.rateLimits && typeof e.rateLimits === 'object') || /\b429\b|rate.?limit|usage limit|session limit|weekly limit|quota/i.test(said);
          const tag = limit ? 'LIMIT' : 'APIERR';
          this.emit(u, 'hi', tag, `${one(e.formatted ?? e.message, 120)} (retry ${n}/${r.maxRetries ?? '?'})`, at, loc);
        }
        break;
      }
      case 'model_refusal_fallback':
        this.emit(u, 'hi', 'MODEL', `refusal fallback ${r.originalModel ?? '?'} → ${r.fallbackModel ?? '?'}`, at, loc);
        break;
      case 'turn_duration':
        st.turnEnded = true;
        st.endedAt = Math.max(st.endedAt, at);
        break;
      case 'informational':
        if (r.level && r.level !== 'info') this.emit(u, 'mid', 'HINT', `system ${r.level}: ${one(r.content, 150)}`, at, loc);
        break;
      case 'local_command':
        this.emit(u, 'mid', 'INJECT', `local command /${r.commandRun?.command ?? '?'} ${one(r.commandRun?.args, 40)}`, at, loc);
        break;
      default:
        break;
    }
  }
  attachment(r, loc, st, at) {
    const u = st.unit;
    const a = r.attachment ?? {};
    switch (a.type) {
      case 'hook_blocking_error':
        this.emit(u, 'hi', 'HOOK', `${a.hookName} blocked: ${one(a.blockingError?.blockingError ?? a.blockingError, 190)}`, at, loc);
        break;
      case 'hook_non_blocking_error':
        this.emit(u, 'hi', 'HOOK', `${a.hookName} exit ${a.exitCode ?? '?'}: ${one(a.stderr || a.stdout, 110)} · ${one(a.command, 80)}`, at, loc);
        break;
      case 'hook_cancelled':
        this.emit(u, 'hi', 'HOOK', `${a.hookName} ${a.timedOut ? 'timed out' : 'cancelled'} after ${age(a.durationMs ?? 0)}: ${one(a.command, 110)}`, at, loc);
        break;
      case 'hook_additional_context':
        this.emit(u, 'lo', 'HINT', `${a.hookName}: ${one(firstLine(a.content), 100)}`, at, null);
        break;
      case 'diagnostics': {
        const errs = (a.files ?? []).flatMap((f) =>
          (f.diagnostics ?? [])
            .filter((d) => /error/i.test(String(d.severity)))
            .map((d) => ({
              text: `${path.basename(String(f.uri))}:${(d.range?.start?.line ?? 0) + 1} ${d.message}`,
              ide: aliasResolves(f.uri, /^Cannot find module '([^']+)'/.exec(String(d.message))?.[1]),
            })),
        );
        const real = errs.filter((e) => !e.ide).map((e) => e.text);
        if (real.length) this.emit(u, 'mid', 'DIAG', `${real.length} error(s): ${one(real.slice(0, 2).join(' | '), 200)}`, at, loc);
        else if (errs.length)
          this.emit(u, 'lo', 'DIAG', `${errs.length} IDE alias error(s), the copy's tsconfig resolves them: ${one(errs[0].text, 150)}`, at, null);
        break;
      }
      case 'queued_command':
        this.prompt(String(a.prompt ?? ''), loc, st, at, 'queued');
        break;
      case 'read_truncation_notice':
        this.emit(u, 'mid', 'BIG', one(a.banner, 170), at, loc);
        break;
      default:
        break;
    }
  }

  // ---- after a pass: open calls, stalls, unit status ----
  ticks() {
    const now = Date.now();
    for (const [name, u] of Object.entries(this.s.units)) {
      const files = Object.values(this.s.files).filter((f) => f.unit === name && f.role !== 'log');
      if (!files.length) continue;
      // Only the live conversation's calls are news: a call cut by a pause in a superseded one never closes (g1 26.10:
      // new conversation after a pause → «OPEN running 74m» of the dead call). Same set as status() reads.
      const [main] = files.filter((f) => f.role === 'main').sort((a, b) => b.lastAt - a.lastAt);
      const live = main ? files.filter((f) => f === main || (f.role === 'sub' && f.sid === main.sid)) : files;
      for (const f of live)
        for (const op of Object.values(f.open)) {
          if (op.openFlagged || op.bg || ['Agent', 'Task', 'AskUserQuestion'].includes(op.name)) continue;
          if (now - op.at >= T.openSec * 1000) {
            op.openFlagged = true;
            this.emit(name, 'mid', 'OPEN', `${op.name} running ${age(now - op.at)} ${one(op.b, 100)}`, now, null);
          }
        }
      // Long processing off the main thread is a cost too: a background task or async subagent past bgLongSec.
      for (const f of files)
        for (const [id, v] of [...Object.entries(f.bg), ...Object.entries(f.subs)]) {
          if (v.longFlagged || now - v.at < T.bgLongSec * 1000 || now - v.at >= T.bgStaleMs) continue;
          v.longFlagged = true;
          this.emit(name, 'mid', 'BGLONG', `${id} running ${age(now - v.at)} ${one(v.b, 100)}`, now, null).waste = 'slow';
        }
      const st = this.status(name);
      const grew = Math.max(...files.map((f) => f.grewAt || f.lastAt || 0));
      const overdue = st.open.find((o) => o.name === 'Bash' && !o.bg && now - o.at > (o.timeout ?? 120000) + 60000);
      if (!st.safe && st.active && (now - grew >= T.stallSec * 1000 || overdue)) {
        if (!u.stallAt || u.stallAt < grew) {
          u.stallAt = now;
          // A stuck turn burns wall time and holds the group: a burn, the plugin pauses at once.
          Object.assign(this.emit(name, 'hi', 'STALL', overdue ? `Bash open ${age(now - overdue.at)}, past its own timeout: ${one(overdue.b, 100)}` : `no transcript growth for ${age(now - grew)} while ${st.reasons.join('; ')}`, now, null), { waste: 'stall', burn: true });
        }
      }
    }
  }
  // Unit status: SAFE = the active conversation's turn ended with nothing open, no live bg, no running subagent.
  status(name) {
    const now = Date.now();
    const files = Object.entries(this.s.files).filter(([, f]) => f.unit === name);
    const mains = files.filter(([, f]) => f.role === 'main').sort((a, b) => b[1].lastAt - a[1].lastAt);
    if (!mains.length) {
      // A mistyped or not-yet-created target is named, never shown as a quiet unit.
      const u = this.s.units[name] ?? {};
      const gone = ['log', 'dir', 'file'].includes(u.kind) && !fs.existsSync(path.resolve(nativePath(u.target)));
      const why = gone ? `${u.kind} missing: ${path.resolve(nativePath(u.target))}` : files.length ? 'log' : 'no transcript yet';
      return { safe: null, active: null, open: [], reasons: [why] };
    }
    const [, active] = mains[0];
    const subs = files.filter(([, f]) => f.role === 'sub' && f.sid === active.sid).map(([, f]) => f);
    const open = [active, ...subs].flatMap((f) => Object.values(f.open));
    const bg = Object.entries(active.bg).filter(([, v]) => now - v.at < T.bgStaleMs);
    const runningSubs = subs.filter((f) => !f.turnEnded && now - f.lastAt < 30 * 60e3);
    const asyncSubs = Object.entries(active.subs).filter(([, v]) => now - v.at < T.bgStaleMs);
    // A turn the host cut (a plugin's `stopped`: paused, done…) leaves no end record — the transcript stops mid-turn.
    // Quiet a minute with nothing open = ended at its last record, never «busy(turn running)» feeding a false STALL
    // (g8 26.10: paused 00:08, busy + STALL at 00:52). An open call stays busy: a live process under a pause is news.
    const stopped = !active.turnEnded && !open.length && now - (active.lastAt || 0) >= 60e3 ? this.stopped?.(name) || null : null;
    const turnEnded = active.turnEnded || !!stopped;
    const reasons = [];
    if (open.length) reasons.push(`open ${open.map((o) => `${o.name} ${age(now - o.at)} ${one(o.b, 50)}`).join(', ')}`);
    if (bg.length) reasons.push(`bg ${bg.length}`);
    if (runningSubs.length || asyncSubs.length) reasons.push(`subs ${Math.max(runningSubs.length, asyncSubs.length)}`);
    if (!turnEnded && !open.length) reasons.push('turn running');
    const safe = turnEnded && !open.length && !bg.length && !runningSubs.length && !asyncSubs.length;
    const last = Math.max(...files.map(([, f]) => f.lastAt || 0));
    const endedAt = stopped ? active.lastAt : active.endedAt;
    return { safe, active, sid: active.sid, open, bg: bg.length, reasons, ctx: active.ctx, last, endedAt, stopped, spent: this.spent[name] ?? null };
  }
}

// ---- digest ------------------------------------------------------------------------------------------------
export function footerLine(name, st, extra = '') {
  const now = Date.now();
  if (st.safe === null) return `[${name}] ${st.reasons.join('; ')}${extra ? ` · ${extra}` : ''}`;
  const head = st.safe ? `SAFE ended ${age(now - st.endedAt)} ago${st.stopped ? ` (cut: ${st.stopped})` : ''}` : `busy(${st.reasons.join('; ')})`;
  const sp = st.spent;
  const spend = sp ? ` · spent ${sp.msgs} msg out ${kc(sp.out)} write ${kc(sp.write)} read ${kc(sp.read)}` : ' · spent 0';
  return `[${name}] ${head} · ctx ${kc(st.ctx ?? 0)}${spend} · last ${st.last ? age(now - st.last) : '?'} · conv ${(st.sid ?? '').slice(0, 8)}${extra ? ` · ${extra}` : ''}`;
}
export function digest({ events, header, footers, budget }) {
  // Owner 25.10: the watcher reads EVERY action. Flags first, then every routine record (call with its command or
  // path, hint, log line) one per line in time order. Over budget only the line WIDTH shrinks — no line, flag or
  // action is ever dropped or collapsed into a count; the budget is soft.
  const lo = events.filter((e) => e.sev === 'lo').sort((a, b) => a.at - b.at);
  const flagged = events.filter((e) => e.sev !== 'lo').sort((a, b) => a.at - b.at);
  const line = (e, n) => `${hms(e.at)} ${e.unit} ${e.tag} ${n ? one(e.text, n) : e.text}${e.ref ? ` ${e.ref}` : ''}`;
  const head = lo.length ? [`── every action (${lo.length}) ──`] : [];
  const build = (midN, loN) =>
    // A hi flag may carry a command to run (STAGE/ENDED audit, show --pack): cut short it cannot be copied.
    [header, ...flagged.map((e) => line(e, e.sev === 'hi' ? 600 : midN)), ...head, ...lo.map((e) => line(e, loN)), ...footers].join('\n');
  let out = build(220, 140);
  for (const [midN, loN] of [[160, 100], [110, 70], [90, 50]]) if (out.length > budget) out = build(midN, loN);
  return out;
}
