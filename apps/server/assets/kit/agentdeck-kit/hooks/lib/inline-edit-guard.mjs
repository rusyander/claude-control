// PreToolUse(Bash|PowerShell): file edits through inline code go through Edit/Write instead.
//
// `python - <<EOF … open(p,'w')`, `node -e "…writeFileSync…"`, `sed -i`, `perl -pi` edit a file without
// passing the Edit/Write guards — language, agent-doc location, secrets, format-on-edit — and a
// `.replace()` / `s///` that misses its text rewrites the file unchanged and says nothing. The shell
// here de-escapes backslashes once, so misses are common, not rare. Measured: one session made 237
// python-heredoc edits; a `node -e` replace silently missed twice in one review run.
// Allowed: writes whose every literal target is a scratch place (temp, scratchpad, `.agent/tmp`), a
// script FILE run by path (it can assert its matches; this guard cannot see inside it), and a repeat
// of the identical call (the escape).
// A shell write into a Markdown file (redirect, tee, Set-Content) is denied too, scratch places aside:
// it puts a doc past the language and doc-location guards on Edit/Write.
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, normalize } from 'node:path';
import { expand, variables } from './destructive-guard.mjs';
import { commandText, executedText } from './shell-text.mjs';
import { shellWords } from './split-worktree.mjs';
import { deny, ownTranscript, readTail, toolEvents, wasJustRefused } from './transcript.mjs';

const INLINE =
  /\b(?:node|python3?|py|deno|bun)(?:\.exe)?\s+(?:(?:-e|--eval|-c|-p|--print)\b|-(?=\s|$))|\b(?:node|python3?|py)(?:\.exe)?\s*<<|\bperl\s+-[a-z]*i/i;
const WRITES =
  /\b(?:writeFileSync|appendFileSync|writeFile|appendFile|write_text|write_bytes)\s*\(|\bopen\s*\([^)]*,\s*['"][wa]b?\+?['"]|\bperl\s+-[a-z]*i/;
const SED_INPLACE =
  /(?:^|[\s;&|("'])sed\s+(?:-[a-zA-Z]*\s+)*-i\b|(?:^|[\s;&|("'])sed\s+(?:-[a-zA-Z]*\s+)*--in-place\b/;
const SCRATCH =
  /(?:[\\/]Temp[\\/]|[\\/]tmp[\\/]|scratchpad|[\\/]\.agent[\\/]tmp[\\/]|^\.agent[\\/]tmp[\\/]|\$TEMP|\$TMP|%TEMP%)/i;
// A path-like literal: has a separator, or ends in a file extension (`JSON.parse` is not a path).
const PATH_WORD =
  /["']?((?:[A-Za-z]:)?[\w.~$%-]*[\\/][^\s"'`;|&)]+|[\w.-]+\.(?:mdx?|jsonc?|ya?ml|toml|[cm]?[jt]sx?|py|go|rs|java|kts?|sh|ps1|s?css|html?|txt|sql|env|lock|xml|csv|ini|cfg|conf))\b["']?/g;

function pathWords(text) {
  const out = [];
  for (const m of text.matchAll(PATH_WORD)) {
    const word = m[1];
    if (/^(?:https?|file):/i.test(word) || /\.(?:exe|cmd|bat)$/i.test(word)) continue;
    // The tail of a URL (`http://inst.localhost` → `//inst.localhost`) names no file.
    if (word.startsWith('//') && text[m.index - 1] === ':') continue;
    // A sed/perl script (`s/a/b/g`, `y/ab/cd/`; PATH_WORD's `\b` may cut its last delimiter) names no file.
    if (/^[sy]([/|#,:@]).*\1/.test(word) && !/\.\w+$/.test(word)) continue;
    // A string escape in code (`"\tif x {\n\t\treturn"`) is no path; a real one carries its drive.
    if (/^\\[ntr]/.test(word)) continue;
    out.push(word);
  }
  return out;
}

const ABSOLUTE = /^(?:[A-Za-z]:)?[\\/]|^[~$%]/;

/**
 * Paths named by the segments that edit, each resolved against the directory it runs in (the hook's
 * cwd, then every `cd` before it). Paths of the other segments are not targets: `sed -i … .agent/tmp/x.json
 * && node tools/tests-cli.mjs …` edits a scratch file only, and `cd .agent/tmp/r; sed -i … x.mjs` too.
 */
function targets(raw, cwd) {
  const text = commandText(raw);
  let dir = String(cwd ?? '');
  let cdEnd = 0;
  const out = [];
  for (const { seg, at } of segments(raw)) {
    const cd = /^\s*cd\s+["']?([^\s"';&|]+)/.exec(seg);
    if (cd) {
      dir = cdInto(dir, cd[1], text, at);
      cdEnd = at + seg.length;
      continue;
    }
    if (!SED_INPLACE.test(seg) && !INLINE.test(seg) && !WRITES.test(seg)) continue;
    // A write naming no path (`p='x.go'` on one line, `open(p,'w')` on the next) is judged by its directory
    // plus every path named from that `cd` on; with no `cd` the directory is the project and the deny stands.
    const named = (SED_INPLACE.test(seg) && sedFiles(seg)) || pathWords(seg);
    const words = named.length ? named : pathWords(text.slice(cdEnd));
    if (!named.length) out.push(dir);
    const vars = variables(text, at);
    for (const word of words)
      for (const value of expand(word, vars)) out.push(resolveIn(dir, value));
  }
  return out;
}

/**
 * The simple commands of `raw` with their offsets in `commandText(raw)`. Separators inside quoted data
 * do not split: a sed script `"s#a';#b#"` is one word (the split cut the script at `;`, so the file
 * operand fell into another segment and a URL in the script was taken as the target).
 */
function segments(raw) {
  const text = commandText(raw);
  const run = executedText(raw, { code: 'spawn' });
  const out = [];
  let at = 0;
  for (const part of run.split(/(?<=&&|\|\||;|\n)/)) {
    out.push({ seg: text.slice(at, at + part.length).replace(/(?:&&|\|\||;|\n)$/, ''), at });
    at += part.length;
  }
  return out;
}

/**
 * The FILE operands of a `sed -i` command — the words after the script (`-e`/`-f` value, else the first
 * plain word), up to a pipe or redirect. A path inside the script is not a target. `null` = no operand
 * found (judge every path word, as before).
 */
function sedFiles(seg) {
  const words = shellWords(seg);
  const at = words.findIndex((w) => /(?:^|[\\/])sed(?:\.exe)?$/i.test(w));
  if (at < 0) return null;
  const files = [];
  let script = false;
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (/^(?:\||&|\d*>|<|&>)/.test(w)) break;
    if (/^(?:-e|--expression|-f|--file)$/.test(w)) {
      script = true;
      i++;
    } else if (/^--(?:expression|file)=/.test(w)) script = true;
    else if (/^(?:-l|--line-length)$/.test(w)) i++;
    else if (/^(?:-i|--in-place)/.test(w) || w === '--') continue;
    else if (/^-[a-zA-Z]*[ef]$/.test(w)) {
      script = true;
      i++;
    } else if (w.startsWith('-') && w.length > 1) continue;
    else if (!script) script = true;
    else files.push(w);
  }
  return files.length ? files : null;
}

function resolveIn(dir, word) {
  return ABSOLUTE.test(word) || !dir ? word : normalize(`${dir}/${word}`);
}

/**
 * The directory a `cd` enters, a variable the command assigned before it expanded (`cd $S/inst-auth` after
 * `S=$W/.agent/tmp/…` stayed `$S/…`, so the scratch copy's file read as a project file). Several values
 * (a `for` list) keep the word as is — the judge stays on the safe side.
 */
function cdInto(dir, word, text, at) {
  const values = expand(word, variables(text, at));
  return resolveIn(dir, values.length === 1 ? values[0] : word);
}

// A script FILE run by path passes this guard (see the head), yet every check keyed on an Edit/Write path
// still needs the files it writes: after a compaction a split group made 17 UI edits through
// `cat > /tmp/x.mjs <<'EOF' … fs.writeFileSync(p, s) … EOF` + `node /tmp/x.mjs` with the package rules
// unread, because rule-injector's card gate keys on `file_path`. `codeWrites` names those files for it.
const SCRIPT_RUN =
  /^\s*(?:\w+=\S*\s+)*(node|nodejs|tsx|python3?|py|bash|sh)(?:\.exe)?((?:\s+-{1,2}[\w-]+(?:=\S+)?)*)\s+["']?([^\s"';&|<>()]+)/i;
// Flags after which the next word is code or a module, not a script file.
const NOT_A_SCRIPT = /(?:^|\s)(?:-e|--eval|-p|--print|-c|-m)(?=\s|=|$)/;
const HEREDOC_BODY =
  /(^|\n)([^\n]*?)<<-?\s*(['"]?)([A-Za-z_]\w*)\3([^\n]*)\n([\s\S]*?)\n[ \t]*\4(?=\s|$)/g;
const REDIRECT_TO = /(?:\d?>{1,2}(?!&)|\btee\s+(?:-a\s+)?)\s*["']?([^\s"';&|<>()]+)/;
const SCRIPT_MAX = 256 * 1024;

/** Heredocs of the command that land in a file: `{ word, body }` per redirect/tee target. */
function heredocFiles(raw) {
  const out = [];
  for (const m of String(raw).matchAll(HEREDOC_BODY)) {
    const to = REDIRECT_TO.exec(`${m[2]} ${m[5]}`)?.[1];
    if (to) out.push({ word: to, body: m[6] });
  }
  return out;
}

// `$TEMP` / `%TEMP%` name the real temp dir; Git Bash's `/tmp` is the same dir on Windows.
function tempPlaces(word) {
  const temp = process.env.TEMP || process.env.TMP || tmpdir();
  const out = [
    word.replace(/\$\{?(?:TEMP|TMP|TMPDIR)\}?|%(?:TEMP|TMP)%/gi, temp.replace(/\\/g, '/')),
  ];
  if (process.platform === 'win32' && /^\/tmp\//.test(word))
    out.push(join(tmpdir(), word.slice(5)));
  return out;
}

/** The text of the script `word` runs: a heredoc of the same command, else a small scratch file. */
function scriptBody(word, dir, heredocs) {
  const own = heredocs.filter((h) => h.word === word || basename(h.word) === basename(word));
  if (own.length) return own[own.length - 1].body;
  for (const place of tempPlaces(word)) {
    const path = resolveIn(dir, place);
    if (!SCRATCH.test(path) && !SCRATCH.test(word)) continue;
    try {
      if (statSync(path).size <= SCRIPT_MAX) return readFileSync(path, 'utf8');
    } catch {
      /* not there */
    }
  }
  return null;
}

// `const base = 'pkg/src/Form/'` then `base + 'types.ts'`, `${base}x.tsx`, `join(base, 'x')`, `base / 'x'`.
const STRING_VAR =
  /(?:\b(?:const|let|var)\s+|^[ \t]*)([A-Za-z_$][\w$]*)\s*=\s*(?:[\w.]+\(\s*)?(['"`])([^'"`\n]*)\2/gm;
const JOINS = [
  [/([A-Za-z_$][\w$]*)\s*\+\s*(['"`])([^'"`\n]+)\2/g, 1, 3, ''],
  [/`\$\{([A-Za-z_$][\w$]*)\}([^`\n]+)`/g, 1, 2, ''],
  [/\bjoin\(\s*([A-Za-z_$][\w$]*)\s*,\s*(['"])([^'"\n]+)\2/g, 1, 3, '/'],
  [/\b([A-Za-z_]\w*)\s*\/\s*(['"])([^'"\n]+)\2/g, 1, 3, '/'],
];
function joinedPaths(body) {
  const vars = new Map();
  for (const m of body.matchAll(STRING_VAR)) if (!m[3].includes('${')) vars.set(m[1], m[3]);
  const out = [];
  if (!vars.size) return out;
  for (const [re, name, tail, sep] of JOINS)
    for (const m of body.matchAll(re))
      if (vars.has(m[name]) && !m[tail].includes('${')) out.push(vars.get(m[name]) + sep + m[tail]);
  return out;
}

// A shell redirect or tee into a source file (`cat > src/x.tsx <<EOF`, `echo … >> f`, `| tee -a f`) edits it as
// much as a script does: `shellWrites` (below) takes every target the way it takes Markdown ones. A target
// is judged like an Edit of it — scratch drops out here, the null device and a log (`> out.log`) match no
// rule's file class; fd duplications (`2>&1`, `>&2`) name no target.
const ANY_TARGET = /^\s*["']?([^\s"';&|<>()]+)(?=["'\s;&|)]|$)/;

function scriptTargets(body, lang, dir, depth) {
  if (/^(?:bash|sh)$/i.test(lang)) return depth < 2 ? codeWrites(body, dir, depth + 1) : [];
  if (!WRITES.test(body)) return [];
  return [...pathWords(body), ...joinedPaths(body)].map((w) => resolveIn(dir, w));
}

/**
 * The non-scratch files this command writes through code: an inline edit (`node -e`, `python - <<EOF`,
 * `sed -i`, `perl -pi` — what `inlineEdit` judges, here also after its repeat escape), a shell redirect or
 * tee target, and a script run by path, its body taken from a heredoc of the same command, else from a small
 * scratch file on disk. Every path word of a writing script counts: a name it only reads errs on the safe side.
 */
export function codeWrites(raw, cwd = '', depth = 0) {
  const text = commandText(raw);
  const out = [];
  const command = executedText(raw, { code: 'keep' });
  if (
    SED_INPLACE.test(executedText(raw, { code: 'spawn' })) ||
    (INLINE.test(command) && WRITES.test(command))
  )
    out.push(...targets(raw, cwd));
  out.push(...shellWrites(raw, cwd, ANY_TARGET));
  const heredocs = heredocFiles(raw);
  let dir = String(cwd ?? '');
  for (const { seg, at } of segments(raw)) {
    const cd = /^\s*cd\s+["']?([^\s"';&|]+)/.exec(seg);
    if (cd) {
      dir = cdInto(dir, cd[1], text, at);
      continue;
    }
    const run = SCRIPT_RUN.exec(seg);
    if (!run || NOT_A_SCRIPT.test(run[2]) || !/[\\/]|\.\w+$/.test(run[3])) continue;
    for (const word of expand(run[3], variables(text, at))) {
      const body = scriptBody(word, dir, heredocs);
      if (body) out.push(...scriptTargets(body, run[1], dir, depth));
    }
  }
  return [...new Set(out)].filter((p) => !SCRATCH.test(p));
}

// A redirect, tee or Set-Content into a Markdown file (`cat > notes.md <<EOF`, `echo … >> README.md`)
// writes a doc past the language and doc-location guards that sit on Edit/Write. Fd duplications
// (`2>&1`, `>&2`) are not writes.
const MD_OP =
  /(?<![\d&<>])>{1,2}(?!&)|\btee\s+(?:(?:-a|--append)\s+)?|\b(?:Out-File|Set-Content|Add-Content)\s+(?:-(?:FilePath|Path|LiteralPath)\s+)?/gi;
const MD_TARGET = /^\s*["']?([^\s"';&|<>()]+\.mdx?)(?=["'\s;&|)]|$)/i;

/** Markdown files this command writes through the shell, each resolved like `targets`. */
export function markdownWrites(raw, cwd = '') {
  return shellWrites(raw, cwd, MD_TARGET);
}

/**
 * The files `target` takes after each redirect, tee or Set-Content of the command, resolved like `targets`.
 * Spawning interpreter code counts only inside its string literals, and a target must be path-like
 * (separator or a file extension): a read-only `node -e "…execSync('git log')…console.log('a','->',o.count)"`
 * named `<pkg>\,o.count` and `e=>e.page+` named `<pkg>\e.page+`, so the rule card denied a read as an edit
 * of the package. `execSync('cat a > b.ts')` still names `b.ts`.
 */
function shellWrites(raw, cwd, target) {
  const text = commandText(raw);
  // Same length as `text`: operators inside quoted data, and spawning code outside its strings, are blanked.
  const run = executedText(raw, { code: 'strings' });
  let dir = String(cwd ?? '');
  let offset = 0;
  const out = [];
  for (const part of run.split(/(?<=&&|\|\||;|\n)/)) {
    const original = text.slice(offset, offset + part.length);
    offset += part.length;
    const cd = /^\s*cd\s+["']?([^\s"';&|]+)/.exec(original);
    if (cd) {
      dir = cdInto(dir, cd[1], text, offset - part.length);
      continue;
    }
    for (const m of part.matchAll(MD_OP)) {
      const to = target.exec(original.slice(m.index + m[0].length));
      if (!to || !pathWords(to[1]).length) continue;
      // `P=.agent/tmp/x; … > $P/y.md` writes scratch: a variable the command assigned is expanded.
      const vars = variables(text, offset - part.length + m.index);
      for (const value of expand(to[1], vars)) out.push(resolveIn(dir, value));
    }
  }
  return out;
}

/** The inline-code or in-place edit this command makes on a non-scratch file, else null. */
export function inlineEdit(raw, cwd = '') {
  if (markdownWrites(raw, cwd).some((p) => !SCRATCH.test(p)))
    return 'a shell write into a Markdown file';
  // Judged on what runs: a heredoc body copied into a file (`cat >> notes.md <<EOF … sed -i … EOF`) and
  // a quoted pattern (`grep "sed -i"`) are text; interpreter code and `bash -c` stay (both shapes
  // denied notes and searches on the guard's first day).
  // A sed inside interpreter code runs only through a spawn; a write API there runs as is.
  const command = executedText(raw, { code: 'keep' });
  const sed = SED_INPLACE.test(executedText(raw, { code: 'spawn' }));
  if (!sed && !(INLINE.test(command) && WRITES.test(command))) return null;
  // Targets keep their quotes' content — a quoted scratch path is still a scratch path.
  const paths = targets(raw, cwd);
  if (paths.length > 0 && paths.every((p) => SCRATCH.test(p))) return null;
  return sed ? 'sed -i' : 'inline code writing a file';
}

// The Bash tool breaks a heredoc command above ~6000 chars (transcript scan 18–25.10: ≤6000 chars 0 of
// ~3900 failed, above it 60 of 117 — «unexpected EOF», «delimited by end-of-file», the rest never runs).
// g5 25.10: two review lanes lost a 9.8 KB `cat >> lane-B.md <<'EOF'` that way, scratch target or not,
// and redid it with Edit — the deny sends there first. Only a heredoc that WRITES a file (redirect or
// tee on its line): a cut there can leave a half-appended file, which an identical retry then doubles;
// a cut heredoc script (`node <<'EOF'`) runs nothing, and its identical retry is the cheap fix.
const HEREDOC_MAX = 6000;
const HEREDOC_WRITE =
  /^[^\n]*(?:\d?>{1,2}(?!&)\s*[^\s&]|\btee\b)[^\n]*<<-?\s*['"]?[A-Za-z_]\w*|^[^\n]*<<-?\s*['"]?[A-Za-z_]\w*['"]?[^\n]*(?:\d?>{1,2}(?!&)\s*[^\s&]|\|\s*tee\b)/m;

/** A heredoc command that writes a file and is long enough for the Bash tool to cut it. */
export function longHeredoc(raw) {
  return String(raw).length > HEREDOC_MAX && HEREDOC_WRITE.test(String(raw));
}

export default function inlineEditGuard(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(input.tool_input?.command ?? '');
  const kind = longHeredoc(command) ? 'heredoc' : inlineEdit(command, input.cwd);
  if (!kind) return null;
  try {
    const events = toolEvents(readTail(ownTranscript(input)));
    if (wasJustRefused(events, tool, (o) => String(o?.command ?? '') === command)) return null;
  } catch {
    /* no transcript → judge the command alone */
  }
  if (kind === 'heredoc')
    return deny(
      `inline-edit-guard: this heredoc command is ${command.length} chars; the Bash tool breaks heredoc ` +
        `commands above ~${HEREDOC_MAX} (about half fail: «unexpected EOF», cut mid-way, the rest never runs). ` +
        'Text into a file → Write (new file) or Edit (append at an anchor); a script → Write it to the ' +
        'scratchpad and run it by path. Repeat this exact call if neither can do it.',
    );
  if (kind.includes('Markdown'))
    return deny(
      `inline-edit-guard: ${kind} skips the guards on Edit/Write (doc language, doc location, secrets). ` +
        'Write the doc with Write, or append with Edit; a draft or a log goes to the scratchpad or .agent/tmp. ' +
        'Repeat this exact call if neither can do it.',
    );
  return deny(
    `inline-edit-guard: ${kind} edits a file outside the Edit/Write guards (language, doc location, secrets, ` +
      'format), and a replace that misses its text rewrites the file unchanged without a word — this shell ' +
      'de-escapes backslashes once, so misses are common. Use Edit (several calls or replace_all) or Write. ' +
      'Many files or generated text → a script FILE in the scratchpad that asserts every match before ' +
      'writing, run by path. Repeat this exact call if neither can do it.',
  );
}
