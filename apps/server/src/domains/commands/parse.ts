import { parse as parseToml } from 'smol-toml';
import { splitSkillFile } from '../../lib/opencode-skill.ts';
import { readText } from './io.ts';

/**
 * Описание команды из её файла. Формат у каждого CLI свой (Markdown с шапкой,
 * TOML), но наружу отдаётся одна пара «описание + подсказка по аргументам».
 */

/** Описание длиннее этого в списке не нужно — карточка станет нечитаемой. */
const DESCRIPTION_LIMIT = 400;

/**
 * Шапка `.md`-команды. Читаем ЛИНИЯМИ, а не полноценным YAML: нужны два
 * необязательных поля, а всё прочее в шапке — дело автора файла, и падать из-за
 * него список не должен.
 */
export function readMdCommand(path: string): { description: string; argumentHint?: string } {
  const text = readText(path);
  if (text === undefined) return { description: '' };

  const parts = splitSkillFile(text);
  if (!parts) {
    // Шапки нет — за описание сходит первая непустая строка тела: это лучше,
    // чем пустая карточка, и это ровно то, что человек увидит в файле.
    return { description: firstMeaningfulLine(text) };
  }

  const header = readHeaderKeys(parts.frontmatter);
  const hint = header['argument-hint'];

  return {
    description: header.description ?? firstMeaningfulLine(parts.body),
    ...(hint ? { argumentHint: hint } : {}),
  };
}

/** Команда Gemini/Qwen: `.toml` с обязательным `prompt` и необязательным `description`. */
export function readTomlCommand(path: string): { description: string; argumentHint?: string } {
  const text = readText(path);
  if (text === undefined) return { description: '' };

  try {
    const parsed = parseToml(text) as { description?: unknown; prompt?: unknown };
    if (typeof parsed.description === 'string') return { description: trim(parsed.description) };
    // Описание необязательно — тогда показываем начало самого промпта: он и есть
    // ответ на вопрос «что эта команда делает».
    if (typeof parsed.prompt === 'string')
      return { description: firstMeaningfulLine(parsed.prompt) };
  } catch {
    // Файл не разбирается — команда всё равно существует, покажем её без описания.
  }
  return { description: '' };
}

/** Простые `ключ: значение` шапки. Кавычки снимаем, вложенность игнорируем. */
function readHeaderKeys(frontmatter: string): Record<string, string> {
  const header: Record<string, string> = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const value = (match[2] ?? '').trim().replace(/^["'](.*)["']$/, '$1');
    if (value) header[match[1]] = trim(value);
  }

  return header;
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith('#') && !item.startsWith('---'));
  return line ? trim(line) : '';
}

export function trim(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > DESCRIPTION_LIMIT ? `${single.slice(0, DESCRIPTION_LIMIT)}…` : single;
}
