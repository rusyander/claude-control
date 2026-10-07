// What of a Bash command is actually a COMMAND (user-facing effect: fewer false denials).
//
// A here-document redirected into a file is data. `cat > suite.test.mjs <<'EOF' … EOF` writes text;
// this shell will never run a line of it. Scanning that body made the guards fire on prose and on
// test code that merely names an operation — 18.09.2026, writing the project-config-sync suite: a
// comment reading "git writes its own exclude file … the restore must fold" was denied as a merge,
// and a line calling `git(dir, 'commit', …)` as a commit. The cure is worse than the disease: it
// teaches rewording the truth out of comments and renaming helpers to appease a regex.
//
// A body that feeds a PROGRAM on stdin (`bash <<'EOF'`, `psql <<SQL`) executes, so it stays in the
// scanned text. Only a body going to a file is dropped.
//
// Residual gap, deliberate and narrow: a shell script written this way and run later is not caught
// by the git guard at write time (`bash x.sh` carries no git token of its own). Writing that script
// through the Write tool was never caught either, so this closes no door that stood open — and the
// guards exist to catch a slip in flight, not to withstand a determined detour around them.
//
// Secrets are the exception: `secret-guard` keeps scanning heredoc bodies, because a key written
// into a file is already leaked.

const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/;
// `> file`, `>> file` or a pipe into tee — the body lands on disk instead of being executed.
const TO_FILE = /(?:^|[^<>])>>?\s*[^\s|;&<>]+|\|\s*tee\b/;

// --- Quoted data (23.09.2026) -------------------------------------------------------------------
// A quoted argument is data unless something in its own simple command runs it. Replayed over 245
// retained denials: 27 were a git/rm/DROP token inside `echo "…"`, a `sed` expression, a `grep`
// pattern, or a `node -e` / `python -` edit of a notes file whose TEXT said "commit".
// What runs a string: a shell or a SQL client (`bash -c`, `ssh host '…'`, `psql -c`), a pipe into
// one, and `$(…)`/backticks inside double quotes. Interpreter code (`node -e`, `python - <<EOF`) is
// judged by the caller: `code: 'keep'` scans it as-is (a delete API is itself the danger), `code:
// 'spawn'` scans it only when it can start a process — `spawnSync('git', ['push'])` stays gated,
// a string that merely says "git push" does not.
// Blanking preserves length (a quoted word → `x`s, a code body → spaces), so an index into the result is an index into
// `commandText(raw)` — destructive-guard reads rm targets from the unblanked text at that index.

const SHELLS =
  /^(?:bash|sh|zsh|dash|ksh|fish|eval|ssh|su|runas|powershell|pwsh|cmd|wsl|watch|parallel|script|xargs|psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse|clickhouse-client|mongosh|mongo|redis-cli|cqlsh|duckdb)$/;
const INTERPRETERS =
  /^(?:node|nodejs|bun|deno|tsx|ts-node|python[\d.]*|py|pypy[\d.]*|ruby|perl|php|awk|gawk|mawk|osascript|rscript|lua|julia)$/;
const SPAWN =
  /child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:Sync|File|FileSync)\s*\(|\bexeca\b|\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*)\b|\bPopen\b|\bpty\.spawn\b|\bBun\.(?:spawn|\$)|\bDeno\.(?:run|Command)\b|\bIO\.popen\b|\bsystem\s*\(|\bshell_exec\b|\bproc_open\b|\bpassthru\b|%x[({]/;

const progName = (word) =>
  String(word)
    .replace(/^.*[\\/]/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
const blank = (s) => s.replace(/[^\n]/g, ' ');
// A blanked ARGUMENT stays a word (`git tag "v1.0"` must still read as a tag with a name), so its
// content becomes `x`s — no guard pattern can be spelled with them.
const blankWord = (s) => s.replace(/[^\n]/g, 'x');
/** Program names of the simple command that owns the here-doc opened on this line. */
const heredocOwner = (line, m) =>
  line
    .slice(0, m.index)
    .split(/[;&|(]/)
    .pop()
    .trim()
    .split(/\s+/)
    .map(progName);

// An interpreter runs a quoted word as code only right after a code flag (`-e`, `-c`, `-p`, `--eval`,
// bundles like perl `-pe` / python `-Bc`, php `-r`) or as awk's positional program; `deno eval` is
// already SHELLS' `eval`. After a script path it is that script's argv: `node x.mjs "rm -rf src"`
// deletes nothing (23.09.2026).
const CODE_FLAG = /^(?:-[A-Za-z]*[ceEpr]|--(?:eval|print)=?)$/;
const AWK = /^(?:awk|gawk|mawk)$/;

function runsString(words, body, quote, code) {
  if (quote === '"' && /\$\(|`/.test(body)) return true;
  const names = words.map(progName);
  if (names.some((n) => SHELLS.test(n))) return true;
  if (!names.some((n) => INTERPRETERS.test(n))) return false;
  const codeArg = names.some((n) => AWK.test(n)) || CODE_FLAG.test(words.at(-1) ?? '');
  return codeArg && (code === 'keep' || SPAWN.test(body));
}

/** Shell text with data-only quoted strings blanked; same length as the input. */
function blankDataStrings(text, code) {
  let out = '';
  let words = [];
  let cur = '';
  let startOut = 0; // where the current simple command began, in `out` and in `text`
  let startIn = 0;
  const flush = () => {
    if (cur) words.push(cur);
    cur = '';
  };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += ch === '"' && text[j] === '\\' ? 2 : 1;
      const body = text.slice(i + 1, j);
      out += runsString(cur ? [...words, cur] : words, body, ch, code)
        ? text.slice(i, j + 1)
        : ch + blankWord(body) + (j < text.length ? ch : '');
      i = j + 1;
      continue;
    }
    if (ch === '\\') {
      out += text.slice(i, i + 2);
      cur += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (/[;&|\n()]/.test(ch)) {
      flush();
      // `echo '…' | sh` — the whole simple command feeds a program that runs it: restore it.
      if (ch === '|' && text[i + 1] !== '|') {
        const next = text.slice(i + 1).match(/^\s*(?:sudo\s+)?([^\s;&|()]+)/);
        const name = next ? progName(next[1]) : '';
        if (SHELLS.test(name) || (INTERPRETERS.test(name) && code === 'keep'))
          out = out.slice(0, startOut) + text.slice(startIn, i);
      }
      out += ch;
      i++;
      words = [];
      startOut = out.length;
      startIn = i;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      out += ch;
      i++;
      continue;
    }
    cur += ch;
    out += ch;
    i++;
  }
  return out;
}

/**
 * The part of a Bash command that executes: file-bound here-doc bodies dropped (`commandText`),
 * data-only quoted strings blanked, interpreter-fed here-doc bodies treated as code (see above).
 * Same length as `commandText(raw)`.
 */
export function executedText(raw, { code = 'keep' } = {}) {
  const lines = commandText(raw).split('\n');
  const parts = [];
  let shell = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    shell.push(line);
    const m = line.match(HEREDOC);
    if (!m || line.includes('<<<')) continue;
    const owner = heredocOwner(line, m);
    if (!owner.some((n) => INTERPRETERS.test(n)) || owner.some((n) => SHELLS.test(n))) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== m[2]) j++;
    const body = lines.slice(i + 1, j).join('\n');
    parts.push(blankDataStrings(shell.join('\n'), code));
    if (j > i + 1) parts.push(code === 'keep' || SPAWN.test(body) ? body : blank(body));
    shell = j < lines.length ? [lines[j]] : [];
    i = j;
  }
  if (shell.length) parts.push(blankDataStrings(shell.join('\n'), code));
  return parts.join('\n');
}

/** The command with file-bound here-doc bodies removed; everything else is untouched. */
export function commandText(raw) {
  const text = String(raw ?? '');
  if (!text.includes('<<')) return text;
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = line.match(HEREDOC);
    // `<<<` is a here-string: one line, no body to skip.
    // A body fed to a shell or an interpreter runs even when its OUTPUT goes to a file
    // (`python - <<'EOF' > out.txt`); only a body a plain writer (`cat`, `tee`) copies is text.
    if (!m || line.includes('<<<') || !TO_FILE.test(line)) continue;
    if (heredocOwner(line, m).some((n) => SHELLS.test(n) || INTERPRETERS.test(n))) continue;
    const terminator = m[2];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== terminator) j++;
    i = j; // the body and its terminator line are dropped together
  }
  return out.join('\n');
}
