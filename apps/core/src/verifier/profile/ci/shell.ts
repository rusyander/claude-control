import { normaliseBinary } from './match.ts';

/**
 * Строка шага CI → простые команды argv без оболочки (P25: никогда строка оболочки). Что без
 * оболочки исполнилось бы иначе — конвейер, перенаправление, подстановка (и внутри двойных
 * кавычек), шаблон пути, `bash -c "…"` — не argv: такую команду считают и называют.
 */

/**
 * Вне кавычек: конвейер, перенаправление, подстановка (`$…`, `%…%` у cmd), фон, группировка,
 * шаблоны путей.
 */
const SHELL_META = /[|><$`()&*?[\]{}%]/;
/** Внутри двойных кавычек оболочка всё ещё подставляет `$…` и `` `…` `` и снимает `\`. */
const DOUBLE_QUOTE_META = /[$`\\]/;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'pwsh', 'powershell']);

/** Оболочка, которой отдают строку (`bash -lc "…"`, `cmd /c …`, `pwsh -Command …`), или `eval`. */
export function isShellInvocation(argv: readonly string[]): boolean {
  const bin = normaliseBinary(argv[0] ?? '').toLowerCase();
  if (bin === 'eval') return true;
  if (!SHELLS.has(bin)) return false;
  return argv
    .slice(1)
    .some(
      (a) =>
        /^-[a-z]*c[a-z]*$/i.test(a) ||
        /^\/[ck]$/i.test(a) ||
        ((bin === 'pwsh' || bin === 'powershell') && /^-e(c)?$/i.test(a)),
    );
}

export interface Segment {
  text: string;
  /** `||` вне кавычек: команда условная, без оболочки её не повторить. */
  conditional: boolean;
}

/** Деление по `&&` и `;` вне кавычек (`echo "a;b"` — одна команда). */
export function splitSegments(line: string): Segment[] {
  const out: Segment[] = [];
  let cur = '';
  let conditional = false;
  let quote: '"' | "'" | null = null;
  const flush = (): void => {
    if (cur.trim() !== '') out.push({ text: cur.trim(), conditional });
    cur = '';
    conditional = false;
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] as string;
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
    if (c === '&' && line[i + 1] === '&') {
      flush();
      i += 1;
      continue;
    }
    if (c === '|' && line[i + 1] === '|') {
      conditional = true;
      cur += '||';
      i += 1;
      continue;
    }
    if (c === ';') {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return out;
}

/** Обёртки, что не меняют команду: `env X=1 make`, `time make`, `exec make`, `command make`. */
const TRANSPARENT = new Set(['env', 'time', 'exec', 'command']);

/** Слова-токены одной простой команды; `null` — в ней есть то, что делает её строкой оболочки. */
export function tokenise(part: string): string[] | null {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const c of part.trim()) {
    if (quote === "'") {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === quote) quote = null;
      else if (DOUBLE_QUOTE_META.test(c)) return null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    // `#` в начале слова — комментарий до конца строки.
    if (c === '#' && !has) break;
    if (SHELL_META.test(c)) return null;
    if (/\s/.test(c)) {
      if (has) tokens.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) return null;
  if (has) tokens.push(cur);
  // Присвоения окружения и прозрачные обёртки впереди команды (`CI=1 env make test`) — не argv.
  while (tokens[0] && (/^[A-Za-z_]\w*=/.test(tokens[0]) || TRANSPARENT.has(tokens[0])))
    tokens.shift();
  if (isShellInvocation(tokens)) return null;
  return tokens;
}
