import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Справка панели глазами агента. Источник один — тексты веба
 * (`shared/config/i18n/help/{ru,en}/topics/<id>.ts`) и порядок разделов из
 * `HELP_GROUPS` (`pages/Help/model/topics.constants.ts`). Своей копии текстов у сервера нет:
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

const TOPICS_FILE = join('pages', 'Help', 'model', 'topics.constants.ts');

/** Исходники веба рядом с сервером: справка живёт там и только там. */
export const DEFAULT_HELP_WEB_SRC = fileURLToPath(
  new URL('../../../../../web/src/', import.meta.url),
);

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

/**
 * Ключи раздела темы `panelAgent` «Как агент связывает разделы»: человек читает
 * его в справке, агент получает его же английский текст в системном промпте.
 * Строка таблицы — пара `topic.linksX` + `topic.linksXText`, агенту она едет
 * одной строкой «X: текст»; подписи таблицы названы вне приставки и не едут.
 */
export const AGENT_LINKS_KEY_PREFIX = 'topic.links';

function linksText(lines: HelpTopicText['lines']): string {
  const own = lines.filter((line) => line.key.startsWith(AGENT_LINKS_KEY_PREFIX));
  const byKey = new Map(own.map((line) => [line.key, line.text]));
  return own
    .filter((line) => !(line.key.endsWith('Text') && byKey.has(line.key.slice(0, -4))))
    .map((line) => {
      const text = byKey.get(`${line.key}Text`);
      return text === undefined ? line.text : `- ${line.text}: ${text}`;
    })
    .join('\n');
}

export interface PanelAgentKnowledge {
  /** Строка на тему: `- <id>: <заголовок> — <сводка> (page <путь>)`. */
  appMap: string;
  /** Раздел «Как агент связывает разделы»; пусто, пока его нет в справке. */
  links: string;
}

/**
 * Что агент панели знает о приложении с первого хода — из справки, а не из
 * своего списка: карта разделов (тема, страница, заголовок, сводка) и раздел
 * темы агента о том, как разделы связаны. Второй копии нет, поэтому и
 * расходиться нечему: новая тема справки попадает к агенту сама. Английская
 * справка — системный промпт модели английский.
 */
export async function panelAgentKnowledge(webSrc: string): Promise<PanelAgentKnowledge> {
  const map: string[] = [];
  let links = '';
  for (const ref of readHelpIndex(webSrc)) {
    const topic = await loadHelpTopic(webSrc, 'en', ref.id);
    const about = topic ? `${topic.title} — ${topic.summary}` : ref.id;
    map.push(`- ${ref.id}: ${about} (page ${ref.pagePath})`);
    if (ref.id === 'panelAgent' && topic) links = linksText(topic.lines);
  }
  return { appMap: map.join('\n'), links };
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
    // «ё» → «е» без русского литерала: разложить, снять две точки, собрать обратно.
    .normalize('NFD')
    .replace(/\u0308/g, '')
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2);

/** Окончания русских слов, длинные первыми: снимается одно, основа — от трёх букв. */
const RU_ENDINGS =
  'иями ями ами иях ией ием иям ого его ому ему ыми ими ях ах ов ев ей ий ый ой ая яя ое ее ые ие ую юю ом ем ам ям ия ию ии ых их ым им а я о е и ы у ю ь й'
    .split(' ')
    .sort((a, b) => b.length - a.length);

/**
 * Грубая основа слова: «хуки», «хуков», «хуком» → «хук»; «rules» → «rule».
 * Сравнение основ, а не начала слова: иначе «права» (разрешения) находили бы
 * «правила» — а это два разных раздела, и путать их человеку нельзя.
 */
export function helpStem(word: string): string {
  if (/[а-я]/.test(word)) {
    const ending = RU_ENDINGS.find((item) => word.endsWith(item) && word.length - item.length >= 3);
    return ending ? word.slice(0, word.length - ending.length) : word;
  }
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Длинная основа совпадает и началом («контур» → «контурный»), короткая — только целиком. */
const stemMatches = (stem: string, term: string): boolean =>
  stem === term || (term.length >= 5 && stem.startsWith(term));

interface TopicIndex {
  counts: Map<string, number>;
  length: number;
  title: Set<string>;
  summary: Set<string>;
  lines: Array<{ key: string; text: string; stems: string[] }>;
}

/** Разбор темы на основы — один раз на загруженный текст (он сам кэшируется по mtime). */
const topicIndexes = new WeakMap<HelpTopicText, TopicIndex>();

function indexOf(topic: HelpTopicText): TopicIndex {
  const cached = topicIndexes.get(topic);
  if (cached) return cached;
  const index: TopicIndex = {
    counts: new Map(),
    length: 0,
    title: new Set(),
    summary: new Set(),
    lines: [],
  };
  for (const line of topic.lines) {
    const stems = words(line.text).map(helpStem);
    for (const stem of stems) index.counts.set(stem, (index.counts.get(stem) ?? 0) + 1);
    index.length += stems.length;
    if (line.key === 'topic.title') stems.forEach((stem) => index.title.add(stem));
    if (line.key === 'topic.summary') stems.forEach((stem) => index.summary.add(stem));
    index.lines.push({ ...line, stems });
  }
  topicIndexes.set(topic, index);
  return index;
}

const countOf = (index: TopicIndex, term: string): number => {
  let count = 0;
  for (const [stem, times] of index.counts) if (stemMatches(stem, term)) count += times;
  return count;
};
const hasStem = (stems: Iterable<string>, term: string): boolean => {
  for (const stem of stems) if (stemMatches(stem, term)) return true;
  return false;
};

/** Насыщение частоты и поправка на длину темы (BM25). */
const K1 = 2;
const B = 0.75;
/** Слово запроса в заголовке темы — сильнейший знак, в сводке — слабее. */
const TITLE_WEIGHT = 3;
const SUMMARY_WEIGHT = 1;
/**
 * Служебное слово — то, о котором говорят почти все темы (от трёх раз в 90 %
 * тем): «что», «как», «это», «панель», «what», «the». Оно выпадает из счёта
 * целиком, списка стоп-слов вести не нужно. Порог по «от трёх раз», а не по
 * одному упоминанию: справка густо ссылается сама на себя, и слово «агент»
 * мелькает в 26 темах из 29, хотя говорит о нём одна.
 */
const COMMON_SHARE = 0.9;
const COMMON_MIN_COUNT = 3;
/** Ниже этого тема задета лишь краем (одно частое слово в длинном тексте) — не находка. */
const SCORE_FLOOR = 0.25;

/**
 * Поиск по справке: BM25 по темам — насыщенная частота основы × её редкость
 * среди тем × поправка на длину, плюс вес заголовка и сводки. Прежний счёт
 * «найденных слов в квадрате» отдавал первые места самым длинным темам, и на
 * «что такое хуки» хуков не было даже в первой тройке
 * (эталон — `help-topics.golden.test.ts`).
 */
export async function searchHelp(
  webSrc: string,
  language: HelpLanguage,
  query: string,
  options: { offset?: number; limit?: number; matchesPerTopic?: number } = {},
): Promise<{ total: number; hits: HelpSearchHit[]; nextOffset?: number }> {
  const queryTerms = [...new Set(words(query).map(helpStem))];
  if (queryTerms.length === 0) return { total: 0, hits: [] };
  const topics: Array<{ topic: HelpTopicText; index: TopicIndex }> = [];
  for (const ref of readHelpIndex(webSrc)) {
    const topic = await loadHelpTopic(webSrc, language, ref.id);
    if (topic) topics.push({ topic, index: indexOf(topic) });
  }
  const total = topics.length;
  if (total === 0) return { total: 0, hits: [] };
  const averageLength = topics.reduce((sum, item) => sum + item.index.length, 0) / total;

  // Редкость основы среди тем; служебные слова выпадают из запроса.
  const terms: Array<{ term: string; idf: number }> = [];
  for (const term of queryTerms) {
    const counts = topics.map((item) => countOf(item.index, term));
    if (counts.filter((count) => count >= COMMON_MIN_COUNT).length >= COMMON_SHARE * total)
      continue;
    const df = counts.filter((count) => count > 0).length;
    if (df === 0) continue;
    terms.push({ term, idf: Math.log(1 + (total - df + 0.5) / (df + 0.5)) });
  }

  const hits: HelpSearchHit[] = [];
  for (const { topic, index } of topics) {
    let score = 0;
    for (const { term, idf } of terms) {
      const count = countOf(index, term);
      const norm = K1 * (1 - B + (B * index.length) / averageLength);
      score += (idf * (count * (K1 + 1))) / (count + norm);
      if (hasStem(index.title, term)) score += TITLE_WEIGHT;
      if (hasStem(index.summary, term)) score += SUMMARY_WEIGHT;
    }
    if (score < SCORE_FLOOR) continue;
    // Строки-доказательства: где сошлось больше редких слов запроса, те и первыми.
    const weightOf = (stems: string[]): number =>
      terms.reduce((sum, { term, idf }) => (hasStem(stems, term) ? sum + idf : sum), 0);
    const matches = index.lines
      .map((line) => ({ line, weight: weightOf(line.stems) }))
      .filter((item) => item.weight > 0)
      .sort((a, b) => b.weight - a.weight || b.line.text.length - a.line.text.length)
      .slice(0, options.matchesPerTopic ?? 3)
      .map(({ line }) => ({ key: line.key, text: line.text }));
    hits.push({
      id: topic.id,
      title: topic.title,
      summary: topic.summary,
      pagePath: topic.pagePath,
      score: Math.round(score * 100) / 100,
      matches,
    });
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
