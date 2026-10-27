/**
 * Пункты описания MR, оставленные «на потом» без дома (g8 26.10, F11): «…делается
 * отдельно.» ушло без ключа задачи, которая это возьмёт, — пункт потерян. Строка с
 * таким оборотом и без ключа трекера (`PROJ-123`) — пробел доставки.
 */

/** Ключ трекера — как `TICKET_KEY` доставки; здесь без флага `g`, чтобы `test` не хранил позицию. */
const KEY = /[A-Z][A-Z0-9]+-\d+/;

/**
 * Обороты «на потом»: глагол дела + «отдельно», «отдельной задачей / тикетом / MR»,
 * англ. «separately», «in a separate / follow-up task». Одно «отдельно» («отдельно
 * проверено») пунктом на потом не считается.
 */
const LATER = [
  /(дела\p{L}*|сдела\p{L}*|исправ\p{L}*|почин\p{L}*|вынес\p{L}*|займ\p{L}*|оформ\p{L}*|остав\p{L}*|перенес\p{L}*|уйд\p{L}*|пойд\p{L}*)\s+(\p{L}+\s+)?отдельн\p{L}*/iu,
  /отдельн\p{L}*\s+(задач\p{L}*|тикет\p{L}*|issue|MR|PR|ПР|МР|мерж\p{L}*)/iu,
  /\b(fix\w*|do(ne)?|handl\w*|address\w*|track\w*|left|leave|move\w*|go(es)?)\s+(\w+\s+)?separately\b/i,
  /\b(in|as|into|to|for)\s+an?\s+(separate|follow[- ]?up)\s+(task|ticket|issue|MR|PR)\b/i,
];

const SHOWN = 3;
const LINE_MAX = 120;

/** Строки описания с оборотом «на потом» без ключа задачи — обрезанные, не больше трёх. */
export function unhomedItems(description: string): string[] {
  const out: string[] = [];
  for (const raw of description.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (!line || KEY.test(line) || !LATER.some((re) => re.test(line))) continue;
    out.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line);
  }
  return out.length > SHOWN ? [...out.slice(0, SHOWN), `+${out.length - SHOWN}`] : out;
}
