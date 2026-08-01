import { parse as parseYaml } from 'yaml';

/** Разделяет YAML-frontmatter и тело markdown. */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };

  const header = match[1] ?? '';

  try {
    const parsed = parseYaml(header) as Record<string, unknown> | null;
    return { frontmatter: parsed ?? {}, body: match[2] ?? '' };
  } catch {
    // Строгий YAML падает на описаниях с двоеточием внутри значения
    // («аудит фронта: axe-core»), хотя сам Claude Code такие файлы читает.
    // Поэтому разбираем шапку построчно — терпимо, как это делает Claude.
    return { frontmatter: parseLooseFrontmatter(header), body: match[2] ?? '' };
  }
}

/**
 * Запасной разбор шапки: ключ до первого двоеточия, значение — весь остаток
 * строки. Кавычки по краям снимаются. Вложенные структуры не поддерживаются,
 * но в SKILL.md их и не бывает: там только name и description.
 */
function parseLooseFrontmatter(header: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!key || key.startsWith('#')) continue;

    if (value.length >= 2 && /^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    result[key] = value;
  }

  return result;
}
