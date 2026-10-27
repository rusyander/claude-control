// PreToolUse(Bash), split group only (AGENTDECK_SPLIT_CHILD=1): a shell command that prints whole files
// or a whole-branch diff into the window is refused above a size cap, with the narrow way named.
//
// One measured group: 297 cat/sed calls carried 866k chars (~12M cache_read), 28 full `git diff`
// ~0.84M, and 24 of 45 persisted outputs were read back whole (~3.7M). read-discipline judges only a
// command that is ONE pure read of ONE file; doc-size-guard judges only Read. `cat a b c`,
// `for f in …; do cat "$f"; done` and `git diff main...HEAD` passed every guard.
//
// Counted: the targets of `cat`/`head`/`tail`/`sed -n 'a,bp'` segments whose output is NOT piped on,
// such a read piped only through stdin line windows (`| head -N`, `| tail -N`, `| sed -n 'a,bp'`) at the
// lines the last window lets through, and the list of a `for v in LIST; do … cat "$v" …; done`. Any other
// pipe target (grep, wc, sort…) leaves the read uncounted. Sizes come from the files themselves; of
// `a || b` only the larger branch counts, redirect targets (`2>/dev/null`) are not files.
// `git diff` without a summary flag runs `--shortstat` with the same arguments first (≤5 s); above
// DIFF_LINES changed lines it is refused. The identical command repeated goes through.
import { closeSync, globSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { expand, variables } from './destructive-guard.mjs';
import {
  deny,
  inSubagent,
  ownTranscript,
  readTail,
  readTailText,
  toolEvents,
  wasJustRefused,
} from './transcript.mjs';

export const READ_CAP = 24_000;
export const DIFF_LINES = 400;
/**
 * Where the CLI starts persisting a shell output instead of returning it (`BASH_MAX_OUTPUT_LENGTH`, the
 * kit's `OURS_CLAUDE_CAPS` and the owner's settings both 8000). A group profile's own `bashOutputMaxChars`
 * is a settings key the hook cannot see — 8000 stays the default then.
 */
export const persistAt = () => Number(process.env.BASH_MAX_OUTPUT_LENGTH) || 8_000;

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

/**
 * Words without shell redirections: `2>/dev/null`, `2> err.log`, `&>x`, `>&2`, `<<EOF`, `<<< s` and their
 * targets go — live 26.10 (#g9:192) `2>/dev/null` was counted as a file `dev/null 0k`. `<file` / `< file`
 * stays as the file it feeds: `cat <f` prints f.
 */
function dropRedirects(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = /^(\d*|&)(>>|>|<<<|<<-?|<)(.*)$/s.exec(list[i]);
    if (!m) {
      out.push(list[i]);
      continue;
    }
    const target = m[3] || list[++i];
    if (m[2] === '<' && (!m[1] || m[1] === '0') && target) out.push(target);
  }
  return out;
}

/**
 * Expand one operand to files (a glob through fs.globSync). A variable the command assigned before it is
 * expanded: `P=src/ui; cat -n $P/a.tsx $P/b.tsx` printed 12.8k chars past the cap unseen (group 5, 25.10:
 * 3 of 6 persisted dumps named their files through `$P`/`$F`). One still unknown stays uncounted.
 */
function filesOf(operand, cwd, vars) {
  return expand(unquote(operand), vars ?? new Map()).flatMap((p) => {
    if (!p || p.startsWith('-') || p.includes('$')) return [];
    if (/[*?[]/.test(p)) {
      try {
        return globSync(p.replace(/\\/g, '/'), { cwd: cwd || '.' }).map((f) => abs(f, cwd));
      } catch {
        return [];
      }
    }
    return [abs(p, cwd)];
  });
}

function sizeOf(file, range) {
  try {
    const st = statSync(file);
    if (!st.isFile()) return 0;
    if (!range) return st.size;
    // head -c N / tail -c N print N bytes, not N lines (live 26.10: `head -c 3000` over 28k was counted whole).
    if (range.chars != null) return Math.min(st.size, range.chars);
    if (st.size > 8_000_000) return st.size;
    const lines = readFileSync(file, 'utf8').split('\n');
    const pick = range.tail ? lines.slice(-range.n) : lines.slice(range.from - 1, range.to);
    return Buffer.byteLength(pick.join('\n'));
  } catch {
    return 0;
  }
}

/** [{file, chars, range?}] that one plain segment prints, or [] when it is not a pure file read. */
function segmentReads(text, cwd, vars) {
  // stdout sent to a file (or /dev/null) never reaches the window.
  if (redirected(text)) return [];
  const w = words(text);
  const cmd = w[0];
  const rest = dropRedirects(w.slice(1));
  const ops = (list) => list.filter((x) => !/^-/.test(unquote(x)));
  if (cmd === 'cat')
    return ops(rest)
      .flatMap((o) => filesOf(o, cwd, vars))
      .map((f) => ({ file: f, chars: sizeOf(f) }));
  if (cmd === 'head' || cmd === 'tail') {
    let n = 10;
    let bytes = false;
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      const x = unquote(rest[i]);
      if (x === '-n' || x === '-c') {
        bytes = x === '-c';
        n = Number(rest[++i]) || n;
        continue;
      }
      const m = /^-([nc]?)(\d+)$/.exec(x);
      if (m) {
        bytes = m[1] === 'c';
        n = Number(m[2]);
        continue;
      }
      files.push(...filesOf(rest[i], cwd, vars));
    }
    const range = bytes
      ? { chars: n, tail: cmd === 'tail' }
      : cmd === 'head'
        ? { from: 1, to: n }
        : { tail: true, n };
    return files.map((f) => ({ file: f, chars: sizeOf(f, range), range }));
  }
  if (cmd === 'sed' && unquote(rest[0] ?? '') === '-n') {
    const m = /^(\d+),(\d+)p$/.exec(unquote(rest[1] ?? ''));
    if (!m) return [];
    const range = { from: Number(m[1]), to: Number(m[2]) };
    return ops(rest.slice(2))
      .flatMap((o) => filesOf(o, cwd, vars))
      .map((f) => ({ file: f, chars: sizeOf(f, range), range }));
  }
  return [];
}

/** Files a `for v in LIST; do … cat "$v" …; done` prints (`cat`/`sed -n`/`head` over $v). */
function loopReads(command, cwd, vars) {
  const out = [];
  for (const m of String(command).matchAll(
    /\bfor\s+(\w+)\s+in\s+([^;]+?)\s*;\s*do\b([\s\S]*?)\bdone\b/g,
  )) {
    const [, v, list, body] = m;
    const usesVar = new RegExp(String.raw`\$\{?${v}\b`);
    // A reader must take $v itself: `grep -o X $f | head -3`, `git cat-file -p R:$f > $f`, `echo "$f $(tail -1 log)"`
    // print no file (live 26.10 g9: two lanes refused at 59k / 54k «of whole files» for such loops).
    const readsVar = segments(body).some(
      (s) => /^\(*(?:cat|head|tail|sed)$/.test(words(s.text)[0] ?? '') && usesVar.test(s.text),
    );
    const prints = readsVar && !/\b(?:cat|head|tail|sed)\b[^;]*\|/.test(body);
    if (!prints) continue;
    // The body is judged per file like a plain command: `head -c 1500 "$f"` prints 1500 bytes, not the file
    // (live 26.10 g9 review: two lanes refused at «59k of whole files» for four 1.5 KB heads). A body the
    // plain path cannot read counts the whole file, as before.
    const ref = new RegExp(String.raw`\$\{?${v}\b\}?`, 'g');
    for (const o of words(list))
      for (const f of filesOf(o, cwd, vars(m.index))) {
        const per = printedReads(
          body.replace(ref, () => f.replace(/\\/g, '/')),
          cwd,
        );
        if (!per.length) out.push({ file: f, chars: sizeOf(f) });
        for (const { list: _l, alt: _a, ...r } of per) out.push(r);
      }
  }
  return out;
}

// `&>x` / `&>>x` send stdout too (g1 audit 26.10: `cat f &>/dev/null` was counted as printing f).
const redirected = (text) =>
  /(?:^|[^2&>])>{1,2}(?!&)|&>{1,2}/.test(text.replace(/"[^"]*"|'[^']*'/g, ''));

/**
 * The first (or last) n BYTES of s as text. Sizes here are UTF-8 bytes: the CLI persists a shell output
 * by its bytes (live 26.10, g9: 6.2k–7.6k-char Cyrillic outputs of 8.7–10.4 KB were persisted while the
 * char count stayed under 8000), and `head -c` / `cut -c` (GNU) count bytes too.
 */
function byteSlice(s, n, tail = false) {
  const b = Buffer.from(s);
  return (tail ? b.subarray(Math.max(0, b.length - n)) : b.subarray(0, n)).toString();
}

/**
 * A stdin line window as a pipeline stage: `head`/`tail` (`-N`, `-n N`, `-nN`, `-n +N`, `-c N`, bare = 10),
 * `sed -n 'a,bp'`, or a width cut `cut -cA-B` / `-c-B` / `-cA-` (`-b` alike), with no file operand.
 * null = any other stage (grep, wc, sort… — size unknown); any extra word (a file operand, a `> file`
 * redirect, an unknown flag, a `cut` list with commas) is null too.
 */
function stdinWindow(text) {
  const w = words(text).map(unquote);
  if (w[0] === 'sed') {
    const m = w.length === 3 && w[1] === '-n' ? /^(\d+),(\d+)p$/.exec(w[2]) : null;
    return m ? { kind: 'lines', from: Number(m[1]), to: Number(m[2]) } : null;
  }
  if (w[0] === 'cut') {
    const spec =
      w.length === 2
        ? /^-[bc](.+)$/.exec(w[1])?.[1]
        : w.length === 3 && /^-[bc]$/.test(w[1])
          ? w[2]
          : null;
    const m = spec ? /^(\d*)-(\d*)$/.exec(spec) : null;
    if (!m || (!m[1] && !m[2])) return null;
    return {
      kind: 'width',
      from: Math.max(1, Number(m[1] || 1)),
      to: m[2] ? Number(m[2]) : Infinity,
    };
  }
  if (w[0] !== 'head' && w[0] !== 'tail') return null;
  let n = 10;
  let bytes = false;
  let sign = '';
  for (let i = 1; i < w.length; i++) {
    let x = w[i];
    if (x === '-n' || x === '-c') {
      bytes = x === '-c';
      x = w[++i] ?? '';
    } else if (/^-[nc].+$/.test(x)) {
      bytes = x[1] === 'c';
      x = x.slice(2);
    } else if (/^-\d+$/.test(x)) x = x.slice(1);
    else return null; // a file operand or an unknown flag: not a window over stdin
    const m = /^([+-]?)(\d+)$/.exec(x);
    if (!m) return null;
    n = Number(m[2]);
    sign = m[1];
  }
  // `head -c -N`/`tail -c +N` are rare; counted as N chars from that end.
  if (bytes) return { kind: 'chars', tail: w[0] === 'tail', n };
  // `head -n -N` = all but the last N lines; `tail -n +N` = from line N on.
  if (w[0] === 'head') return { kind: 'lines', from: 1, to: sign === '-' ? -n || Infinity : n };
  return sign === '+' ? { kind: 'lines', from: Math.max(1, n), to: Infinity } : { kind: 'tail', n };
}

/** Lines of one pipeline reader (`cat`, `head`/`tail`/`sed -n` over files) as [{file, s}], or null. */
function readerLines(text, cwd, vars) {
  const w = words(text);
  const cmd = w[0];
  if (cmd !== 'cat' && cmd !== 'head' && cmd !== 'tail' && cmd !== 'sed') return null;
  const numbered = cmd === 'cat' && w.slice(1).some((x) => /^-\w*n/.test(unquote(x)));
  const out = [];
  for (const { file, range } of segmentReads(text, cwd, vars)) {
    let lines;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 8_000_000) continue;
      const text = readFileSync(file, 'utf8');
      lines = (range?.chars == null ? text : byteSlice(text, range.chars, range.tail)).split('\n');
    } catch {
      continue;
    }
    if (lines.at(-1) === '') lines.pop();
    if (range && range.chars == null)
      lines = range.tail ? lines.slice(-range.n) : lines.slice(range.from - 1, range.to);
    // `cat -n` prefixes every line with a 6-wide number and a tab.
    for (const s of lines) out.push({ file, s: numbered ? `${' '.repeat(7)}${s}` : s });
  }
  return out;
}

function applyWindow(lines, win) {
  if (win.kind === 'lines') return lines.slice(win.from - 1, win.to);
  if (win.kind === 'tail') return win.n ? lines.slice(-win.n) : [];
  if (win.kind === 'width')
    return lines.map((l) => ({
      file: l.file,
      s: Buffer.from(l.s)
        .subarray(win.from - 1, win.to)
        .toString(),
    }));
  // `-c N`: N bytes of the stream, cut inside a line.
  const seq = win.tail ? [...lines].reverse() : lines;
  const out = [];
  let left = win.n;
  for (const l of seq) {
    if (left <= 0) break;
    const take = Math.min(Buffer.byteLength(l.s) + 1, left);
    out.push({ file: l.file, s: byteSlice(l.s, Math.max(0, take - 1), win.tail) });
    left -= take;
  }
  return win.tail ? out.reverse() : out;
}

/**
 * A pipeline whose stages after the reader are ALL stdin line windows (`cat f | head -150`, `head -500 f |
 * tail -100`) prints those lines to the window — counted at their real sizes. Live 26.10: `cat big.tsx |
 * head -150` passed as «output goes on». null = not such a pipeline (the old rule applies).
 */
function pipelineReads(stages, cwd, vars) {
  const windows = stages.slice(1).map(stdinWindow);
  if (windows.some((x) => !x)) return null;
  const lines = readerLines(stages[0], cwd, vars);
  if (!lines) return null;
  const shown = windows.reduce(applyWindow, lines);
  const per = new Map();
  for (const l of shown) per.set(l.file, (per.get(l.file) ?? 0) + Buffer.byteLength(l.s) + 1);
  return [...per].map(([file, chars]) => ({ file, chars }));
}

/**
 * Everything the command prints of whole files into the window, each read tagged with its `list` (a run
 * between `;`, `&`, newlines) and `alt` (an `||` alternative inside it) — see `judgedReads`.
 */
export function printedReads(command, cwd) {
  const text = String(command ?? '').replace(/\bfor\s+\w+\s+in[\s\S]*?\bdone\b/g, ' ');
  let from = 0;
  let list = 0;
  let alt = 0;
  const located = segments(text).map((s) => {
    const at = text.indexOf(s.text, from);
    from = at < 0 ? from : at + s.text.length;
    const tagged = { ...s, at: at < 0 ? from : at, list, alt };
    if (s.next === '||') alt++;
    else if (s.next !== '&&' && s.next !== '|') {
      list++;
      alt = 0;
    }
    return tagged;
  });
  const plain = [];
  const tag = (s) => (r) => ({ ...r, list: s.list, alt: s.alt });
  for (let i = 0; i < located.length; i++) {
    const s = located[i];
    if (s.next !== '|') {
      plain.push(...segmentReads(s.text, cwd, variables(text, s.at)).map(tag(s)));
      continue;
    }
    // A pipeline: its stages up to the first segment not followed by `|`.
    let j = i;
    while (j < located.length - 1 && located[j].next === '|') j++;
    const counted = pipelineReads(
      located.slice(i, j + 1).map((x) => x.text),
      cwd,
      variables(text, s.at),
    );
    if (counted) {
      plain.push(...counted.map(tag(s)));
      i = j;
    }
  }
  const loops = loopReads(command, cwd, (at) => variables(String(command), at));
  return [...plain, ...loops.map((r) => ({ ...r, list: `for${list}`, alt: 0 }))];
}

/**
 * The reads that reach the window: per list, the heaviest `||` alternative — `a || b` prints a, or b when
 * a failed, never both in full (live 26.10: two 1–80 line windows of PROGRESS.md were summed into a refusal).
 * `a && b` and `a; b` still add up.
 */
export function judgedReads(reads) {
  const lists = new Map();
  for (const r of reads) {
    const alts = lists.get(r.list) ?? new Map();
    const one = alts.get(r.alt) ?? { chars: 0, reads: [] };
    one.chars += r.chars;
    one.reads.push(r);
    alts.set(r.alt, one);
    lists.set(r.list, alts);
  }
  return [...lists.values()].flatMap(
    (alts) => [...alts.values()].reduce((a, b) => (b.chars > a.chars ? b : a)).reads,
  );
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
const BRIEF_HEAD = 256 * 1024;
/**
 * The conversation opened with the panel's brief carrying every one of `rels` (`## Notebook <rel>`, the
 * header cold-brief writes) and was not compacted since — otherwise the text is not in the window and the
 * generic refusal stands. A compaction older than the 3 MB tail goes unseen (rare: a brief-opened run that
 * long has compacted inside its tail too).
 */
function briefCarries(transcript, rels) {
  if (!transcript) return false;
  let head = '';
  let fd;
  try {
    const buf = Buffer.alloc(Math.min(BRIEF_HEAD, statSync(transcript).size));
    fd = openSync(transcript, 'r');
    readSync(fd, buf, 0, buf.length, 0);
    head = buf.toString('utf8');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const header = (rel) => [`## Notebook ${rel}\\n`, `## Notebook ${rel}\n`];
  if (!rels.every((rel) => header(rel).some((h) => head.includes(h)))) return false;
  return !readTailText(transcript).includes('"compact_boundary"');
}
/**
 * A file's label in the refusal: the path as the command's directory sees it (`../.agent/PROGRESS.md`), so
 * two files never share one — the last two segments used to print `.agent/PROGRESS.md` for both (#g9:192).
 * More than two levels up, another drive or no cwd → the full path.
 */
export function label(file, cwd) {
  const full = String(file).replace(/\\/g, '/');
  if (!cwd) return full;
  const rel = relative(cwd, String(file)).replace(/\\/g, '/');
  return rel && !isAbsolute(rel) && !/^(?:\.\.\/){3}/.test(rel) ? rel : full;
}

/** Commands that only print: their output sent to /dev/null leaves nothing behind. */
const PRINTERS = new Set([
  'echo',
  'printf',
  'cat',
  'head',
  'tail',
  'sed',
  'grep',
  'rg',
  'wc',
  'ls',
  'cut',
  'sort',
  'nl',
]);

/** Stdout targets of a segment's words: `>f`, `> f`, `1>>f`, `&>f`; `>&2` names fd 2. */
function stdoutTargets(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const m = /^(\d*|&)(>>|>)(.*)$/s.exec(list[i]);
    if (!m || (m[1] && m[1] !== '1' && m[1] !== '&')) continue;
    const target = m[3] || list[++i] || '';
    out.push(unquote(target));
  }
  return out;
}

/**
 * No-op segments (g1 audit 26.10, F9): a pure printer whose stdout goes only to /dev/null and whose exit code
 * is dropped (`;` follows, not `&&`/`||`/`|`, not fed by a pipe). Live: `sed -n 26,28p f >/dev/null; …` and
 * `echo "- <drafted line>" >> /dev/null; grep -c "" notebook` — a drafted line thrown away, then the real
 * write by Edit: one extra message, ~95k cache_read. A `$(…)` or backtick may act — never judged.
 */
export function noopSegments(command) {
  const list = segments(command);
  return list.filter((s, i) => {
    if (s.next !== ';' || (i > 0 && list[i - 1].next === '|')) return false;
    if (/\$\(|`/.test(s.text)) return false;
    const w = words(s.text);
    let j = 0;
    while (j < w.length && /^[A-Za-z_]\w*=/.test(w[j])) j++;
    const cmd = unquote(w[j] ?? '').replace(/^.*[\\/]/, '');
    if (!PRINTERS.has(cmd)) return false;
    const rest = w.slice(j + 1);
    if (cmd === 'sed' && rest.some((x) => /^-[a-zA-Z]*i|^--in-place/.test(x))) return false;
    const sinks = stdoutTargets(rest);
    return sinks.length > 0 && sinks.every((t) => /^\/dev\/null$|^nul$/i.test(t));
  });
}

export default function bashReadCap(input) {
  if (!splitChild()) return null;
  // A lane is judged too (g5 25.10: 17 of the 32 persisted outputs were review lanes'), its repeat escape
  // against its OWN transcript; a child whose file cannot be found is skipped — the escape would never open.
  const transcript = ownTranscript(input);
  if (inSubagent(input) && !/[\\/]subagents[\\/]/.test(transcript)) return null;
  if (input?.tool_name !== 'Bash' && input?.tool_name !== 'PowerShell') return null;
  const command = String(input?.tool_input?.command ?? '');
  if (!command.trim()) return null;
  const cwd = input?.cwd;
  const reads = judgedReads(printedReads(command, cwd));
  const total = reads.reduce((s, r) => s + r.chars, 0);
  const top = () =>
    [...reads]
      .sort((a, b) => b.chars - a.chars)
      .slice(0, 4)
      .map((r) => `${label(r.file, cwd)} ${k(r.chars)}`)
      .join(', ');
  let reason = null;
  if (total > READ_CAP) {
    reason =
      `bash-read-cap: this command prints ~${k(total)} chars of whole files (${top()}) — every char is ` +
      're-billed on each later turn, and above 8k the output is persisted and read back again. Read what the task ' +
      "needs: Grep the symbol, then Read with offset/limit (or `sed -n 'a,bp'` per range).";
  } else if (total > persistAt()) {
    // Just over the persist threshold the shell output is saved to a file and only a ~2k preview arrives;
    // every one of the 32 such outputs in g5 (7.9–9.6k mostly) was then Read back whole — paid twice.
    reason =
      `bash-read-cap: this command prints ~${k(total)} chars of files (${top()}) — above ${k(persistAt())} the ` +
      'shell output is persisted: a 2k preview arrives and the whole file gets read again. Read the file with ' +
      'Read (offset/limit for a range) — the text arrives once — or split the ranges into calls under ' +
      `${k(persistAt())}.`;
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
  const noop = reason ? [] : noopSegments(command);
  if (noop.length > 0) {
    const shown = noop[0].text.length > 80 ? `${noop[0].text.slice(0, 79)}…` : noop[0].text;
    reason =
      `bash-read-cap: \`${shown}\` prints only to /dev/null and its exit code is dropped (\`;\` follows) — it does ` +
      'nothing but cost a call. Drop it: draft text belongs in your answer or straight in Edit/Write; to test a ' +
      'command, chain it with && or ||.';
  }
  if (!reason) return null;
  // g9 review F11 (26.10): the first call of every new conversation was `cat .agent/PROGRESS.md; cat
  // .agent/run/notebook.agent.md` (16k), refused by the generic text and re-read whole by Read. These notes
  // already ride in the panel's brief at the top of the conversation (≤8k whole, a longer one up to the
  // line it names). Letting the cat through would persist the output and have it read back — paid twice.
  const names = [...new Set(reads.map((r) => label(r.file, cwd)))];
  if (names.length && briefCarries(transcript, names)) {
    reason =
      `bash-read-cap: ${names.join(', ')} — the panel's brief at the top of this conversation already carries these ` +
      'notes — whole, up to the line it names, or as a heading index. Do not read them again whole; read only ' +
      'the part the brief points at, with Read <file> offset/limit.';
  }
  const events = toolEvents(readTail(transcript));
  const same = (other) => String(other?.command ?? '').trim() === command.trim();
  if (wasJustRefused(events, input.tool_name, same)) return null;
  const escape = noop.length > 0 ? 'the segment is truly needed' : 'the whole text is truly needed';
  return deny(`${reason} Repeat this identical command if ${escape}.`);
}
