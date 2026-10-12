/**
 * Просьба агенту из «Логов»: выбранная строка и строки вокруг неё, с
 * замаскированными секретами. Человек видит текст в поле чата до отправки, но
 * токен в длинном фрагменте глазами не заметить — маскируем сами.
 */

export const CONTEXT_LINES = 20;
/** Предел фрагмента: длиннее — агенту дороже, а причина обычно рядом со строкой. */
export const MAX_SNIPPET_CHARS = 8000;

const MASK = '••••';
const SECRET_KEY =
  '(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth(?:orization)?|cookie|session)';

const PATTERNS: [RegExp, string][] = [
  // Bearer eyJ… / Basic dXNl… — первым: иначе `Authorization: ` ниже съест одно слово «Bearer»
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
  // "password":"x" и 'token': 'x'
  [new RegExp(`(["']?\\w*${SECRET_KEY}\\w*["']?\\s*:\\s*)(["'])[^"']*\\2`, 'gi'), `$1$2${MASK}$2`],
  // password=x, token: x, API_KEY=x
  [new RegExp(`(\\b\\w*${SECRET_KEY}\\w*\\s*[=:]\\s*)(?!["'])[^\\s,;&"']+`, 'gi'), `$1${MASK}`],
  // postgres://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
];

export function maskSecrets(text: string): string {
  return PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
}

/** Строки вокруг выбранной: до `CONTEXT_LINES` с каждой стороны, в пределах `MAX_SNIPPET_CHARS`. */
export function snippetAround(
  lines: string[],
  index: number,
): { text: string; from: number; to: number } {
  let from = Math.max(0, index - CONTEXT_LINES);
  let to = Math.min(lines.length - 1, index + CONTEXT_LINES);
  const size = () => lines.slice(from, to + 1).reduce((sum, line) => sum + line.length + 1, 0);
  // Сначала срезаем хвост после строки: причина чаще выше неё, чем ниже.
  while (size() > MAX_SNIPPET_CHARS && to > index) to -= 1;
  while (size() > MAX_SNIPPET_CHARS && from < index) from += 1;
  const text = lines
    .slice(from, to + 1)
    .join('\n')
    .slice(0, MAX_SNIPPET_CHARS);
  return { text: maskSecrets(text), from, to };
}
