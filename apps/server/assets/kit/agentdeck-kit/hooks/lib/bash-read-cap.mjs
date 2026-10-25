// PreToolUse(Bash), split group only (AGENTDECK_SPLIT_CHILD=1): a shell command that prints whole files
// or a whole-branch diff into the window is refused above a size cap, with the narrow way named.
//
// One measured group: 297 cat/sed calls carried 866k chars (~12M cache_read), 28 full `git diff`
// ~0.84M, and 24 of 45 persisted outputs were read back whole (~3.7M). read-discipline judges only a
// command that is ONE pure read of ONE file; doc-size-guard judges only Read. `cat a b c`,
// `for f in …; do cat "$f"; done` and `git diff main...HEAD` passed every guard.
//
// Counted: the targets of `cat`/`head`/`tail`/`sed -n 'a,bp'` segments whose output is NOT piped on,
// and the list of a `for v in LIST; do … cat "$v" …; done`. Sizes come from the files themselves.
// `git diff` without a summary flag runs `--shortstat` with the same arguments first (≤5 s); above
// DIFF_LINES changed lines it is refused. The identical command repeated goes through.
import { globSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { deny, inSubagent, readTail, toolEvents, wasJustRefused } from './transcript.mjs';

export const READ_CAP = 24_000;
export const DIFF_LINES = 400;

const splitChild = () => process.env.AGENTDECK_SPLIT_CHILD === '1';
const unquote = (w) => w.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
const abs = (p, cwd) => (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) ? p : resolve(cwd || '.', p));

/** Shell segments with the operator that follows each (`|` means the output goes on, not to the window). */
export function segments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(command ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push({ text: cur.trim(), next: two });
      cur = '';
      i++;
      continue;
    }
    // `2>&1`, `&>` are redirections, not a background operator.
    if (c === '&' && (s[i - 1] === '>' || s[i + 1] === '>')) {
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      out.push({ text: cur.trim(), next: c === '\n' ? ';' : c });
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push({ text: cur.trim(), next: '' });
  return out.filter((x) => x.text);
}

const words = (text) => text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

/** Expand one operand to files (a glob through fs.globSync). */
function filesOf(operand, cwd) {
  const p = unquote(operand);
  if (!p || p.startsWith('-') || p.includes('$')) return [];
  if (/[*?[]/.test(p)) {
    try {
      return globSync(p.replace(/\\/g, '/'), { cwd: cwd || '.' }).map((f) => abs(f, cwd));
    } catch {
      return [];
    }
  }
  return [abs(p, cwd)];
}

function sizeOf(file, range) {
  try {
    const st = statSync(file);
    if (!st.isFile()) return 0;
    if (!range) return st.size;
    if (st.size > 8_000_000) return st.size;
    const lines = readFileSync(file, 'utf8').split('\n');
    const pick = range.tail ? lines.slice(-range.n) : lines.slice(range.from - 1, range.to);
    return pick.join('\n').length;
  } catch {
    return 0;
  }
}

/** [{file, chars}] that one plain segment prints, or [] when it is not a pure file read. */
function segmentReads(text, cwd) {
  // stdout sent to a file (or /dev/null) never reaches the window.
  if (/(?:^|[^2&>])>{1,2}(?!&)/.test(text.replace(/"[^"]*"|'[^']*'/g, ''))) return [];
  const w = words(text);
  const cmd = w[0];
  const rest = w.slice(1);
  const ops = (list) => list.filter((x) => !/^-/.test(unquote(x)));
  if (cmd === 'cat')
    return ops(rest)
      .flatMap((o) => filesOf(o, cwd))
      .map((f) => ({ file: f, chars: sizeOf(f) }));
  if (cmd === 'head' || cmd === 'tail') {
    let n = 10;
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      const x = unquote(rest[i]);
      if (x === '-n' || x === '-c') {
        n = Number(rest[++i]) || n;
        continue;
      }
      const m = /^-n?(\d+)$/.exec(x);
      if (m) {
        n = Number(m[1]);
        continue;
      }
      files.push(...filesOf(rest[i], cwd));
    }
    const range = cmd === 'head' ? { from: 1, to: n } : { tail: true, n };
    return files.map((f) => ({ file: f, chars: sizeOf(f, range) }));
  }
  if (cmd === 'sed' && unquote(rest[0] ?? '') === '-n') {
    const m = /^(\d+),(\d+)p$/.exec(unquote(rest[1] ?? ''));
    if (!m) return [];
    const range = { from: Number(m[1]), to: Number(m[2]) };
    return ops(rest.slice(2))
      .flatMap((o) => filesOf(o, cwd))
      .map((f) => ({ file: f, chars: sizeOf(f, range) }));
  }
  return [];
}

/** Files a `for v in LIST; do … cat "$v" …; done` prints (`cat`/`sed -n`/`head` over $v). */
function loopReads(command, cwd) {
  const out = [];
  for (const m of String(command).matchAll(
    /\bfor\s+(\w+)\s+in\s+([^;]+?)\s*;\s*do\b([\s\S]*?)\bdone\b/g,
  )) {
    const [, v, list, body] = m;
    const usesVar = new RegExp(String.raw`\$\{?${v}\b`).test(body);
    const prints =
      /\b(?:cat|head|tail|sed\s+-n)\b/.test(body) && !/\b(?:cat|head|tail|sed)\b[^;]*\|/.test(body);
    if (!usesVar || !prints) continue;
    for (const o of words(list))
      for (const f of filesOf(o, cwd)) out.push({ file: f, chars: sizeOf(f) });
  }
  return out;
}

/** Everything the command prints of whole files into the window. */
export function printedReads(command, cwd) {
  const segs = segments(String(command ?? '').replace(/\bfor\s+\w+\s+in[\s\S]*?\bdone\b/g, ' '));
  const plain = segs.filter((s) => s.next !== '|').flatMap((s) => segmentReads(s.text, cwd));
  return [...plain, ...loopReads(command, cwd)];
}

const SUMMARY =
  /--(?:stat|shortstat|numstat|name-only|name-status|quiet|exit-code|check|dirstat|summary)\b/;

/** `git diff` segments printed whole: `{dir, args}` for the shortstat probe. */
export function fullDiffs(command, cwd) {
  const out = [];
  for (const s of segments(command)) {
    if (s.next === '|') continue;
    const w = words(s.text).map(unquote);
    if (w[0] !== 'git') continue;
    let i = 1;
    let dir = cwd;
    while (w[i] === '-C' || w[i] === '-c' || w[i]?.startsWith('--no-pager')) {
      if (w[i] === '-C') dir = abs(w[i + 1] ?? '.', cwd);
      i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
    }
    if (w[i] !== 'diff') continue;
    const args = w.slice(i + 1);
    if (args.some((a) => SUMMARY.test(a))) continue;
    out.push({ dir, args });
  }
  return out;
}

/** Changed lines of a diff by `--shortstat` with the same arguments; null = could not tell. */
export function diffLines({ dir, args }) {
  const dd = args.indexOf('--');
  const head = dd < 0 ? args : args.slice(0, dd);
  const tail = dd < 0 ? [] : args.slice(dd);
  const r = spawnSync('git', ['-C', dir || '.', 'diff', '--shortstat', ...head, ...tail], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const ins = /(\d+) insertion/.exec(r.stdout);
  const del = /(\d+) deletion/.exec(r.stdout);
  return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
}

const k = (n) => `${Math.round(n / 1000)}k`;
const short = (f) => String(f).replace(/\\/g, '/').split('/').slice(-2).join('/');

export default function bashReadCap(input) {
  if (!splitChild() || inSubagent(input)) return null;
  if (input?.tool_name !== 'Bash' && input?.tool_name !== 'PowerShell') return null;
  const command = String(input?.tool_input?.command ?? '');
  if (!command.trim()) return null;
  const cwd = input?.cwd;
  const reads = printedReads(command, cwd);
  const total = reads.reduce((s, r) => s + r.chars, 0);
  let reason = null;
  if (total > READ_CAP) {
    const top = [...reads]
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 4)
      .map((r) => `${short(r.file)} ${k(r.chars)}`);
    reason =
      `bash-read-cap: this command prints ~${k(total)} chars of whole files (${top.join(', ')}) — every char is ` +
      're-billed on each later turn, and above 8k the output is persisted and read back again. Read what the task ' +
      "needs: Grep the symbol, then Read with offset/limit (or `sed -n 'a,bp'` per range).";
  } else {
    for (const d of fullDiffs(command, cwd)) {
      const n = diffLines(d);
      if (n !== null && n > DIFF_LINES) {
        reason =
          `bash-read-cap: this git diff is ${n} changed lines. Run it with --stat first, then ` +
          '`git diff <same refs> -- <path>` for the files you need.';
        break;
      }
    }
  }
  if (!reason) return null;
  const events = toolEvents(readTail(input.transcript_path));
  const same = (other) => String(other?.command ?? '').trim() === command.trim();
  if (wasJustRefused(events, input.tool_name, same)) return null;
  return deny(`${reason} Repeat this identical command if the whole text is truly needed.`);
}
