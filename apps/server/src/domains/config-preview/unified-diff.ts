import { maskSecretsInText } from '../../lib/secret-mask.ts';
import { diffLines } from '../history.ts';

/**
 * Унифицированный дифф «было → станет» для карточки подтверждения.
 *
 * Построчное сравнение — `diffLines` ленты истории, второго LCS здесь нет. Своё
 * только обрамление: общие начало и конец отрезаются ДО сравнения. Иначе правка
 * одной строки в `~/.claude.json` (мегабайты истории проектов) означала бы
 * квадратичную таблицу на весь файл, а карточка ждала бы секунды.
 */

/** Сколько строк контекста вокруг правки — как у `git diff`. */
const CONTEXT_LINES = 3;
/** Порог таблицы LCS на ИЗМЕНЁННОЙ середине: выше — честное «слишком велико». */
const MAX_LCS_CELLS = 4_000_000;

export interface UnifiedDiff {
  diff: string;
  added: number;
  removed: number;
  /** Середина правки слишком велика для построчного сравнения — диффа нет. */
  truncated: boolean;
}

type Op = { kind: 'ctx' | 'add' | 'del'; text: string };

const SIGN: Record<Op['kind'], string> = { ctx: ' ', add: '+', del: '-' };

/**
 * Строки текста. CRLF приводим к LF: форма файла — не правка. Хвостовой перевод
 * строки завершает последнюю строку, а не открывает пустую: иначе у нового
 * файла в диффе появлялась бы лишняя строка `+`.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Сравнение середины через `diffLines`. Он отбрасывает один хвостовой перевод
 * строки, поэтому склеиваем с ним явно — пустая последняя строка иначе терялась
 * бы. Пустую сторону разбираем сами: `'\n'` он прочёл бы как одну пустую строку.
 */
function middleOps(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((text) => ({ kind: 'add', text }));
  if (b.length === 0) return a.map((text) => ({ kind: 'del', text }));
  return diffLines(`${a.join('\n')}\n`, `${b.join('\n')}\n`).lines.map((line) => ({
    kind: line.kind,
    text: line.text,
  }));
}

/**
 * Значение секрета в строке диффа прячется. Карточку видит человек, но она
 * лежит и в `GET /api/agent/pending`, и в соседней строке контекста может
 * оказаться чужой токен, которого эта правка вообще не касается. Детектор —
 * общий для всего, что видит агент (`lib/secret-mask.ts`): заголовок в аргументе,
 * пароль в адресе и непрозрачный ключ прячутся так же, как пара «имя — значение».
 * Ссылка `${VAR}` — не секрет, она остаётся видна.
 */
export { isSecretName, SECRET_MASK } from '../../lib/secret-mask.ts';

export function maskSecretsInLine(line: string): string {
  return maskSecretsInText(line);
}

export function unifiedDiff(path: string, before: string, after: string): UnifiedDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) {
    return { diff: '', added: 0, removed: 0, truncated: false };
  }
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    return { diff: '', added: midB.length, removed: midA.length, truncated: true };
  }

  const ops: Op[] = [
    ...a.slice(0, head).map((text): Op => ({ kind: 'ctx', text })),
    ...middleOps(midA, midB),
    ...a.slice(a.length - tail).map((text): Op => ({ kind: 'ctx', text })),
  ];

  const header = `--- a/${path}\n+++ b/${path}`;
  const hunks = collectHunks(ops);
  const added = ops.filter((op) => op.kind === 'add').length;
  const removed = ops.filter((op) => op.kind === 'del').length;
  return { diff: [header, ...hunks].join('\n'), added, removed, truncated: false };
}

/** Ханки с контекстом: правки ближе 2×контекста друг к другу сливаются в один. */
function collectHunks(ops: Op[]): string[] {
  const changed = ops.flatMap((op, index) => (op.kind === 'ctx' ? [] : [index]));
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = end;
    else ranges.push([start, end]);
  }

  // Номера строк считаются по всему файлу: сколько строк каждой стороны прошло
  // до начала ханка.
  return ranges.map(([start, end]) => {
    let oldLine = 1;
    let newLine = 1;
    for (let index = 0; index < start; index += 1) {
      if (ops[index]!.kind !== 'add') oldLine += 1;
      if (ops[index]!.kind !== 'del') newLine += 1;
    }
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((op) => op.kind !== 'add').length;
    const newCount = slice.filter((op) => op.kind !== 'del').length;
    const body = slice.map((op) => `${SIGN[op.kind]}${maskSecretsInLine(op.text)}`);
    return [
      `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`,
      ...body,
    ].join('\n');
  });
}
