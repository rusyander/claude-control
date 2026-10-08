/**
 * Чтение XML ровно в том объёме, который нужен импорту, — без зависимостей.
 *
 * Импорт разбирает два чужих XML: отчёт JUnit из CI и лист внутри `.xlsx`
 * (книга Excel — это zip с XML внутри). Оба плоские: нужен список элементов
 * одного имени, их атрибуты и текст. Ради этого тянуть в сервер парсер XML
 * незачем — тем более что сервер идёт под `--experimental-strip-types` и каждая
 * новая зависимость здесь стоит дороже обычного.
 *
 * ОГРАНИЧЕНИЯ (осознанные): без пространств имён, без DTD, без валидации.
 * Разбор ЩАДЯЩИЙ — чужой файл может быть обрезан или собран криво, и это повод
 * вернуть то, что удалось прочитать, а не уронить импорт целиком.
 *
 * Обратное направление (запись XML) живёт в `export-cases.ts`: чтение и запись
 * здесь — разные задачи с разными правилами, общего кода у них нет.
 */

/** Элемент как его видит импорт: атрибуты и всё, что между тегами. */
export interface XmlElement {
  attributes: Record<string, string>;
  /** Внутренность элемента как есть; у самозакрывающегося — пустая строка. */
  body: string;
}

/** Именованные сущности XML. Числовые разбираются отдельно, в `decodeXml`. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Текст без экранирования: `&amp;`, `&#10;`, `&#x41;` — всё это одно и то же. */
export function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Атрибуты открывающего тега. Значение в любых кавычках, регистр имени как есть. */
export function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    attributes[name] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

/**
 * Все элементы с этим именем, вложенные в том числе.
 *
 * Вложенность считается: `<testsuite>` внутри `<testsuite>` — обычное дело в
 * отчётах JUnit, и без счётчика глубины первый же закрывающий тег обрубил бы
 * внешний элемент на середине.
 */
export function findElements(xml: string, tag: string): XmlElement[] {
  const found: XmlElement[] = [];
  let at = 0;
  while (at < xml.length) {
    const start = findOpenTag(xml, tag, at);
    if (start < 0) break;
    const head = findTagEnd(xml, start + tag.length + 1);
    if (!head) break;
    const attributes = parseAttributes(xml.slice(start + tag.length + 1, head.end));
    if (head.selfClosing) {
      found.push({ attributes, body: '' });
      at = head.end + 1;
      continue;
    }
    const close = findClose(xml, tag, head.end + 1);
    if (close < 0) {
      // Тег не закрыт — берём остаток файла: обрезанный отчёт лучше пустого.
      found.push({ attributes, body: xml.slice(head.end + 1) });
      break;
    }
    found.push({ attributes, body: xml.slice(head.end + 1, close) });
    at = head.end + 1;
  }
  return found;
}

/** Первый элемент с этим именем — или ничего. */
export function findElement(xml: string, tag: string): XmlElement | undefined {
  return findElements(xml, tag)[0];
}

/**
 * Текст элемента: теги выброшены, CDATA раскрыта, сущности разобраны.
 *
 * CDATA вырезается ОТДЕЛЬНО и её содержимое не трогается вовсе — в этом весь
 * её смысл. Сначала раскрыть её, а потом вычищать теги нельзя: `<![CDATA[<a>]]>`
 * превратился бы в пустоту, а именно так чужие репортёры кладут в отчёт
 * фрагмент разметки или стек падения.
 */
export function textContent(body: string): string {
  const OPEN = '<![CDATA[';
  const CLOSE = ']]>';
  let result = '';
  let at = 0;
  while (at < body.length) {
    const start = body.indexOf(OPEN, at);
    if (start < 0) {
      result += stripMarkup(body.slice(at));
      break;
    }
    result += stripMarkup(body.slice(at, start));
    const end = body.indexOf(CLOSE, start + OPEN.length);
    if (end < 0) {
      result += body.slice(start + OPEN.length);
      break;
    }
    result += body.slice(start + OPEN.length, end);
    at = end + CLOSE.length;
  }
  return result.trim();
}

/** Кусок вне CDATA: комментарии и теги долой, сущности разобрать. */
function stripMarkup(part: string): string {
  return decodeXml(part.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ''));
}

/** Начало открывающего тега `<tag`, а не `<tagname`. */
function findOpenTag(xml: string, tag: string, from: number): number {
  let at = from;
  while (at < xml.length) {
    const found = xml.indexOf(`<${tag}`, at);
    if (found < 0) return -1;
    const next = xml[found + tag.length + 1];
    if (next === undefined || /[\s/>]/.test(next)) return found;
    at = found + 1;
  }
  return -1;
}

/** Конец открывающего тега. Кавычки учитываются: в значении может быть `>`. */
function findTagEnd(xml: string, from: number): { end: number; selfClosing: boolean } | undefined {
  let quote = '';
  for (let index = from; index < xml.length; index += 1) {
    const char = xml[index];
    if (char === undefined) break;
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return { end: index, selfClosing: xml[index - 1] === '/' };
  }
  return undefined;
}

/** Позиция закрывающего тега своего уровня. */
function findClose(xml: string, tag: string, from: number): number {
  let depth = 1;
  let at = from;
  while (at < xml.length) {
    const close = xml.indexOf(`</${tag}`, at);
    if (close < 0) return -1;
    const open = findOpenTag(xml, tag, at);
    if (open >= 0 && open < close) {
      const head = findTagEnd(xml, open + tag.length + 1);
      if (!head) return -1;
      if (!head.selfClosing) depth += 1;
      at = head.end + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) return close;
    at = close + tag.length + 3;
  }
  return -1;
}
