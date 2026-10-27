// PreToolUse(Bash) on win32: a node call that names `/tmp/…` where Git Bash does not translate it gets a
// one-line hint (context, never a refusal).
//
// Git Bash (MSYS) turns `/tmp/x` into the Windows temp path only when it is a WHOLE argument (`node
// /tmp/x.mjs`, `--out=/tmp/x`, `x=/tmp/x`). Inside node's code — `-e`/`-p` text, a here-doc or here-string
// fed to node, a path quoted inside an argument — `/tmp/x` reaches node.exe as is, and node resolves it to
// `C:\tmp\x`. Live 26.10 (g8 #76, a repeat of #23): bash wrote `/tmp/laneA-oldbase.json` into the MSYS temp,
// then `node -e "require('/tmp/laneA-oldbase.json')"` died with MODULE_NOT_FOUND.
//
// Not counted: bash-only `/tmp` use (`cat /tmp/x`, `> /tmp/x`), a shell redirect of the node call (`node -e
// … > /tmp/out`), a whole `/tmp/…` argument (unless MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL switch the
// translation off). A script file's own text is not read.

export const HINT =
  'node-tmp-hint: node.exe resolves /tmp as C:\\tmp — Git Bash translates /tmp only as a whole argument, never ' +
  'inside node code or a quoted string. Pass the path as its own argument (process.argv), or write the Windows ' +
  'form: "$(cygpath -m /tmp)/x.json" (forward slashes, safe inside a JS string) or the scratchpad path.';

// `/tmp` as a path start: not part of a longer path (`/c/x/tmp`, `C:/tmp`) or a name (`my/tmp`).
const TMP = /(?:^|[\s'"`(=,;[{])\/tmp(?:\/|(?![\w.-]))/;
// A whole argument MSYS translates: `/tmp…`, or `name=/tmp…` / `--opt=/tmp…`.
const WHOLE = /^(?:-{0,2}[\w.-]+=)?\/tmp(?:\/|$)/;
// node at a command position: start, after a separator, `$(`, `(`, a backtick; env assignments and
// wrappers before it; a path to node.exe.
const NODE_AT =
  /(?:^|[;&|\n(`]|\$\()\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:env|time|command|exec)\s+)*(?:"[^"\n]*[\\/]node(?:\.exe)?"|(?:[\w.~:\\/-]*[\\/])?node(?:\.exe)?)(?=\s|$)/g;

/** Text of one node invocation from `from`: up to an unquoted `;`, `&&`, `||`, `|`, newline, `)` or backtick. */
function invocation(s, from) {
  let quote = null;
  let depth = 0;
  let i = from;
  for (; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (
      c === ';' ||
      c === '\n' ||
      c === '|' ||
      c === '`' ||
      (c === '&' && s[i + 1] !== '>' && s[i - 1] !== '>')
    )
      break;
  }
  return s.slice(from, i);
}

/** Shell words with their quotes removed: `[{ value }]`. */
function words(text) {
  const out = [];
  let cur = null;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
      continue;
    }
    cur ??= '';
    if (c === '"' || c === "'") quote = c;
    else if (c === '\\' && i + 1 < text.length) cur += text[++i];
    else cur += c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Bodies of the here-docs opened on the line where `at` sits (`<<EOF`, `<<-'EOF'`). */
function heredocBodies(s, at, text) {
  const bodies = [];
  const lineEnd = s.indexOf('\n', at);
  if (lineEnd < 0) return bodies;
  let rest = s.slice(lineEnd + 1).split('\n');
  for (const m of text.matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) {
    const end = rest.findIndex((l) => l.trim() === m[2]);
    bodies.push((end < 0 ? rest : rest.slice(0, end)).join('\n'));
    rest = end < 0 ? [] : rest.slice(end + 1);
  }
  return bodies;
}

/** Does this node invocation (its arguments, the node word excluded) name `/tmp/…` MSYS leaves as is? */
function namesRawTmp(text, bodies, noConv) {
  const w = words(text);
  for (let i = 0; i < w.length; i++) {
    const x = w[i];
    // Shell redirections and their targets are bash's, not node's (`> /tmp/out`, `2>/tmp/err`, `< /tmp/in`).
    if (x === '<<<') {
      if (TMP.test(w[i + 1] ?? '')) return true;
      i++;
      continue;
    }
    const redirect = /^(?:\d*|&)(?:>>?|<<-?|<)(.*)$/.exec(x);
    if (redirect && !/^\d+$/.test(x)) {
      if (!redirect[1]) i++;
      continue;
    }
    if (!TMP.test(x)) continue;
    if (!noConv && WHOLE.test(x)) continue;
    return true;
  }
  return bodies.some((b) => TMP.test(b));
}

/**
 * The command with the bodies of here-docs NOT fed to node blanked (`cat > x.mjs <<'EOF'` — a file's text,
 * not commands) and `$(cygpath …)` folded (the advised fix names `/tmp` and is right).
 */
function prepared(command) {
  const lines = String(command ?? '')
    .replace(/\$\(cygpath\s[^)]*\)/g, 'CYGPATH')
    .split('\n');
  for (let i = 0; i < lines.length; i++) {
    const marks = [...lines[i].matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)];
    if (!marks.length) continue;
    NODE_AT.lastIndex = 0;
    const fedToNode = NODE_AT.test(lines[i]);
    NODE_AT.lastIndex = 0;
    let j = i + 1;
    for (const m of marks) {
      while (j < lines.length && lines[j].trim() !== m[2]) {
        if (!fedToNode) lines[j] = '';
        j++;
      }
      j++;
    }
    i = j - 1;
  }
  return lines.join('\n');
}

/** True when a Bash command runs node with `/tmp/…` inside node's own arguments or code (any platform). */
export function rawTmpInNode(command) {
  const s = prepared(command);
  if (!s.includes('/tmp') || !/node/.test(s)) return false;
  const noConv = /\bMSYS_NO_PATHCONV=1\b|\bMSYS2_ARG_CONV_EXCL=/.test(s);
  for (const m of s.matchAll(NODE_AT)) {
    // The match ends right after the node word: what follows up to the separator is node's.
    const from = m.index + m[0].length;
    const text = invocation(s, from);
    if (namesRawTmp(text, heredocBodies(s, from, text), noConv)) return true;
  }
  return false;
}

/** Rules-channel item: the hint line, or null. `platform` is a parameter so tests can name win32 anywhere. */
export default function nodeTmpHint(input, platform = process.platform) {
  if (platform !== 'win32') return null;
  if (input?.tool_name !== 'Bash') return null;
  return rawTmpInNode(input?.tool_input?.command) ? HINT : null;
}
