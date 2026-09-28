import { blockLang, blockLangPattern } from '@agentdeck/contracts/brand';

/**
 * Блок ответа модели для служебных вызовов групп: тройная кавычка, наш язык
 * `agentdeck:<вид>`, внутри — JSON или текст файла.
 *
 * Правила те же, что у блоков чата (разделение, ревью): берётся ПОСЛЕДНИЙ
 * закрытый блок нужного вида — модель иногда повторяет пример из промпта в
 * рассуждении, а итог пишет в конце. Незакрытый блок не считается: оборванный
 * ответ не должен превращаться в полуфайл на диске.
 */
export function readAnswerBlock(text: string, kind: string): string | undefined {
  const open = new RegExp(
    `(?:^|\\n)[ \\t]*\`\`\`[ \\t]*${blockLangPattern(kind)}[ \\t]*\\r?\\n`,
    'g',
  );
  let found: string | undefined;
  for (const match of text.matchAll(open)) {
    const start = (match.index ?? 0) + match[0].length;
    const close = /(?:^|\r?\n)[ \t]*```[ \t]*(?:\r?\n|$)/.exec(text.slice(start));
    if (!close) continue;
    found = text.slice(start, start + close.index);
  }
  return found;
}

/** JSON из последнего блока вида; нет блока или JSON сломан — `undefined`. */
export function readJsonBlock(text: string, kind: string): unknown {
  const body = readAnswerBlock(text, kind);
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** Промпт каталога с подставленным языком блока: имя продукта живёт в одном месте. */
export function withBlockLang(prompt: string, kind: string): string {
  return prompt.replaceAll('{{block}}', blockLang(kind));
}

/** Конец сбалансированного JSON-значения с `start` (`{` или `[`), с учётом строк; нет — -1. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Все закрытые блоки кода ответа — с любым языком или без него, по порядку. */
function fencedBodies(text: string): string[] {
  return [...text.matchAll(/```[^\n`]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)].map((m) => m[1] ?? '');
}

/**
 * JSON-объект ответа с ключом-массивом `arrayKey`, терпимо к форме ответа.
 * Модель не всегда пишет ровно наш блок: берёт ```json, пишет вступление,
 * отвечает голым JSON или обрывается на середине. По порядку: наш блок →
 * любой блок кода → первый объект в тексте → из оборванного ответа — все
 * ЦЕЛЫЕ элементы массива (недописанный хвост отбрасывается, выдумывать его
 * нельзя). Ничего — `undefined`.
 */
export function readJsonLoose(
  text: string,
  kind: string,
  arrayKey: string,
): Record<string, unknown> | undefined {
  const wanted = (value: Record<string, unknown> | undefined): boolean =>
    Array.isArray(value?.[arrayKey]);
  const own = readAnswerBlock(text, kind);
  const fromOwn = own === undefined ? undefined : parseObject(own);
  if (wanted(fromOwn)) return fromOwn;
  for (const body of fencedBodies(text).reverse()) {
    const parsed = parseObject(body.trim());
    if (wanted(parsed)) return parsed;
  }
  for (let at = text.indexOf('{'); at >= 0; at = text.indexOf('{', at + 1)) {
    const end = balancedEnd(text, at);
    if (end < 0) continue;
    const parsed = parseObject(text.slice(at, end + 1));
    if (wanted(parsed)) return parsed;
  }
  const head = new RegExp(`"${arrayKey}"\\s*:\\s*\\[`).exec(text);
  if (!head) return undefined;
  const items: unknown[] = [];
  let at = head.index + head[0].length;
  for (;;) {
    const next = text.slice(at).search(/\S/);
    if (next < 0 || text[at + next] !== '{') break;
    const start = at + next;
    const end = balancedEnd(text, start);
    if (end < 0) break;
    const item = parseObject(text.slice(start, end + 1));
    if (item) items.push(item);
    const comma = /^\s*,/.exec(text.slice(end + 1));
    if (!comma) break;
    at = end + 1 + comma[0].length;
  }
  return items.length > 0 ? { [arrayKey]: items } : undefined;
}
