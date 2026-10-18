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
import { normalize } from 'node:path';
import { commandText, executedText } from './shell-text.mjs';
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
    // A sed/perl script (`s/a/b/g`, `y/ab/cd/`; PATH_WORD's `\b` may cut its last delimiter) names no file.
    if (/^[sy]([/|#,:@]).*\1/.test(word) && !/\.\w+$/.test(word)) continue;
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
function targets(text, cwd) {
  let dir = String(cwd ?? '');
  const out = [];
  for (const seg of text.split(/&&|\|\||;|\n/)) {
    const cd = /^\s*cd\s+["']?([^\s"';&|]+)/.exec(seg);
    if (cd) {
      dir = resolveIn(dir, cd[1]);
      continue;
    }
    if (!SED_INPLACE.test(seg) && !INLINE.test(seg) && !WRITES.test(seg)) continue;
    for (const word of pathWords(seg)) out.push(resolveIn(dir, word));
  }
  return out;
}

function resolveIn(dir, word) {
  return ABSOLUTE.test(word) || !dir ? word : normalize(`${dir}/${word}`);
}

// A redirect, tee or Set-Content into a Markdown file (`cat > notes.md <<EOF`, `echo … >> README.md`)
// writes a doc past the language and doc-location guards that sit on Edit/Write. Fd duplications
// (`2>&1`, `>&2`) are not writes.
const MD_OP =
  /(?<![\d&<>])>{1,2}(?!&)|\btee\s+(?:(?:-a|--append)\s+)?|\b(?:Out-File|Set-Content|Add-Content)\s+(?:-(?:FilePath|Path|LiteralPath)\s+)?/gi;
const MD_TARGET = /^\s*["']?([^\s"';&|<>()]+\.mdx?)(?=["'\s;&|)]|$)/i;

/** Markdown files this command writes through the shell, each resolved like `targets`. */
export function markdownWrites(raw, cwd = '') {
  const text = commandText(raw);
  // Same length as `text`: operators inside quoted data or interpreter code are blanked there.
  const run = executedText(raw, { code: 'spawn' });
  let dir = String(cwd ?? '');
  let offset = 0;
  const out = [];
  for (const part of run.split(/(?<=&&|\|\||;|\n)/)) {
    const original = text.slice(offset, offset + part.length);
    offset += part.length;
    const cd = /^\s*cd\s+["']?([^\s"';&|]+)/.exec(original);
    if (cd) {
      dir = resolveIn(dir, cd[1]);
      continue;
    }
    for (const m of part.matchAll(MD_OP)) {
      const target = MD_TARGET.exec(original.slice(m.index + m[0].length));
      if (target) out.push(resolveIn(dir, target[1]));
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
  const paths = targets(commandText(raw), cwd);
  if (paths.length > 0 && paths.every((p) => SCRATCH.test(p))) return null;
  return sed ? 'sed -i' : 'inline code writing a file';
}

export default function inlineEditGuard(input) {
  const tool = input?.tool_name;
  if (tool !== 'Bash' && tool !== 'PowerShell') return null;
  const command = String(input.tool_input?.command ?? '');
  const kind = inlineEdit(command, input.cwd);
  if (!kind) return null;
  try {
    const events = toolEvents(readTail(ownTranscript(input)));
    if (wasJustRefused(events, tool, (o) => String(o?.command ?? '') === command)) return null;
  } catch {
    /* no transcript → judge the command alone */
  }
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
