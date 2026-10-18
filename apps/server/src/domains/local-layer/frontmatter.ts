import { globToRegExp } from '../project-git/mirror-local.ts';

/**
 * Шапка правила (`---` … `---`) и её ключ `paths` — ровно то, что CLI читает,
 * решая, грузить правило сразу или при касании пути. Остальные ключи шапки
 * слою не нужны: текст правила CLI отдаёт модели без шапки (замерено пробой
 * 18.10.2026 на claude 2.1.286), так же отдаёт и слой.
 */

export interface RuleText {
  body: string;
  /** `undefined` — ключа нет, правило грузится в начале сессии. */
  paths?: string[];
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return quoted ? (quoted[2] as string) : trimmed;
}

function inlineList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).split(',').map(unquote).filter(Boolean);
  }
  // Одна строка может нести несколько шаблонов через запятую — так их пишут в `paths: a, b`.
  return trimmed.split(',').map(unquote).filter(Boolean);
}

export function parseRule(text: string): RuleText {
  const match = FENCE.exec(text);
  if (!match) return { body: text };
  const head = (match[1] as string).split(/\r?\n/);
  const body = text.slice(match[0].length).replace(/^\s*\n/, '');
  const at = head.findIndex((line) => /^paths\s*:/.test(line));
  if (at < 0) return { body };
  const inline = (head[at] as string).replace(/^paths\s*:/, '');
  if (inline.trim()) return { body, paths: inlineList(inline) };
  const paths: string[] = [];
  for (const line of head.slice(at + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (!item) break;
    paths.push(unquote(item[1] as string));
  }
  return { body, paths };
}

/** `src/**\/*.{ts,tsx}` → два шаблона: `globToRegExp` фигурных скобок не знает. */
export function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const head = pattern.slice(0, match.index);
  const tail = pattern.slice(match.index + match[0].length);
  return (match[1] as string).split(',').flatMap((part) => expandBraces(`${head}${part}${tail}`));
}

/** Шаблоны правила против пути от его базы; регистр не важен там, где не важен диску. */
export function globsMatch(globs: readonly string[], relPath: string, caseless: boolean): boolean {
  const path = relPath.replaceAll('\\', '/');
  return globs.some((glob) =>
    expandBraces(glob).some((one) => {
      const re = globToRegExp(one);
      return new RegExp(re.source, caseless ? 'i' : '').test(path);
    }),
  );
}
