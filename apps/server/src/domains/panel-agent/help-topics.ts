import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Справка панели глазами агента. Источник один — тексты веба
 * (`shared/config/i18n/help/{ru,en}/topics/<id>.ts`) и порядок разделов из
 * `HELP_GROUPS` (`pages/Help/model/topics.ts`). Своей копии текстов у сервера нет:
 * человек читает справку в панели, и агент обязан цитировать ровно её.
 *
 * Модуль темы — чистый TS с одним именованным объектом и type-only импортом,
 * поэтому грузится `import()` под `--experimental-strip-types`. `HELP_GROUPS`
 * так не загрузить (там React-компоненты), и его разбирает регулярное выражение.
 * Оба кэшируются по mtime: правка справки видна без перезапуска сервера.
 */

export type HelpLanguage = 'ru' | 'en';

export interface HelpTopicRef {
  id: string;
  pagePath: string;
  group: string;
}

export interface HelpTopicText {
  id: string;
  title: string;
  summary: string;
  pagePath: string;
  /** Строки документа по порядку: путь ключа и текст. */
  lines: Array<{ key: string; text: string }>;
}

const TOPICS_FILE = join('pages', 'Help', 'model', 'topics.ts');

let indexCache: { file: string; mtime: number; topics: HelpTopicRef[] } | undefined;

/** Порядок и страницы тем из `HELP_GROUPS`. */
export function readHelpIndex(webSrc: string): HelpTopicRef[] {
  const file = join(webSrc, TOPICS_FILE);
  const mtime = statSync(file).mtimeMs;
  if (indexCache?.file === file && indexCache.mtime === mtime) return indexCache.topics;
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf('HELP_GROUPS');
  if (start < 0) throw new Error(`HELP_GROUPS не найден в ${file}`);
  const topics: HelpTopicRef[] = [];
  let group = '';
  // Запись группы — `labelKey: '…'`, запись темы — объект с `id` и `pagePath`
  // (в одну строку или разнесённый форматером на несколько).
  const pattern = /labelKey:\s*'([^']+)'|\{\s*id:\s*'([^']+)',[^{}]*?pagePath:\s*'([^']*)'/g;
  for (const match of source.slice(start).matchAll(pattern)) {
    if (match[1]) group = match[1];
    else if (match[2]) topics.push({ id: match[2], pagePath: match[3] ?? '', group });
  }
  if (topics.length === 0) throw new Error(`В HELP_GROUPS не разобрано ни одной темы (${file})`);
  indexCache = { file, mtime, topics };
  return topics;
}

const topicCache = new Map<string, { mtime: number; text: HelpTopicText }>();
/** Время правки файла при первой загрузке модуля: с ним модуль лежит в кэше под чистым адресом. */
const firstMtime = new Map<string, number>();

function flatten(value: unknown, prefix: string, out: Array<{ key: string; text: string }>): void {
  if (typeof value === 'string') {
    out.push({ key: prefix, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

/** Текст одной темы; неизвестная тема — `undefined`. */
export async function loadHelpTopic(
  webSrc: string,
  language: HelpLanguage,
  id: string,
): Promise<HelpTopicText | undefined> {
  const ref = readHelpIndex(webSrc).find((topic) => topic.id === id);
  if (!ref) return undefined;
  const file = join(webSrc, 'shared', 'config', 'i18n', 'help', language, 'topics', `${id}.ts`);
  if (!existsSync(file)) return undefined;
  const mtime = statSync(file).mtimeMs;
  const cacheKey = `${file}`;
  const cached = topicCache.get(cacheKey);
  if (cached?.mtime === mtime) return cached.text;

  // Правленный файл грузится под новым ключом (фрагмент с версией) — иначе кэш
  // модулей Node отдал бы старый текст. Первая загрузка — по чистому адресу:
  // с суффиксом преобразователь vitest не узнаёт TypeScript и падает на
  // `import type`, а Node принимает оба вида.
  const first = firstMtime.get(file);
  if (first === undefined) firstMtime.set(file, mtime);
  const href = pathToFileURL(file).href;
  const url = first === undefined || first === mtime ? href : `${href}#v=${mtime}`;
  const module = (await import(url)) as Record<string, unknown>;
  const root = Object.values(module).find((item) => item && typeof item === 'object');
  if (!root) throw new Error(`Модуль справки ${file} не экспортирует объект текстов`);
  const lines: Array<{ key: string; text: string }> = [];
  flatten(root, '', lines);
  const topic = (root as { topic?: { title?: unknown; summary?: unknown } }).topic;
  const text: HelpTopicText = {
    id,
    title: typeof topic?.title === 'string' ? topic.title : id,
    summary: typeof topic?.summary === 'string' ? topic.summary : '',
    pagePath: ref.pagePath,
    lines,
  };
  topicCache.set(cacheKey, { mtime, text });
  return text;
}

export interface HelpSearchHit {
  id: string;
  title: string;
  summary: string;
  pagePath: string;
  score: number;
  /** Строки темы с совпадением — ключ нужен для `read_help_topic`. */
  matches: Array<{ key: string; text: string }>;
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);

/**
 * Поиск по справке: слова запроса (от трёх букв) против строк тем. Совпадение
 * по началу слова, чтобы «контур» находил «контура» и «контуров» без стеммера.
 * Заголовок и сводка весят больше тела.
 */
export async function searchHelp(
  webSrc: string,
  language: HelpLanguage,
  query: string,
  options: { offset?: number; limit?: number; matchesPerTopic?: number } = {},
): Promise<{ total: number; hits: HelpSearchHit[]; nextOffset?: number }> {
  const terms = [...new Set(words(query))].map((term) =>
    term.length > 5 ? term.slice(0, term.length - 2) : term,
  );
  if (terms.length === 0) return { total: 0, hits: [] };
  const hits: HelpSearchHit[] = [];
  for (const ref of readHelpIndex(webSrc)) {
    const topic = await loadHelpTopic(webSrc, language, ref.id);
    if (!topic) continue;
    let score = 0;
    const matches: HelpSearchHit['matches'] = [];
    for (const line of topic.lines) {
      const lineWords = words(line.text);
      const found = terms.filter((term) => lineWords.some((word) => word.startsWith(term)));
      if (found.length === 0) continue;
      const weight = line.key === 'topic.title' || line.key === 'topic.summary' ? 5 : 1;
      score += found.length * found.length * weight;
      matches.push(line);
    }
    if (score > 0) {
      hits.push({
        id: topic.id,
        title: topic.title,
        summary: topic.summary,
        pagePath: topic.pagePath,
        score,
        matches: matches
          .sort((a, b) => b.text.length - a.text.length)
          .slice(0, options.matchesPerTopic ?? 3),
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 5;
  return {
    total: hits.length,
    hits: hits.slice(offset, offset + limit),
    ...(offset + limit < hits.length ? { nextOffset: offset + limit } : {}),
  };
}
