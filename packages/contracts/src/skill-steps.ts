import { knobPlainText } from './group-knobs.ts';

/**
 * Шаги в тексте скилла и шаг, к которому относится число группы, — ОДИН разбор
 * на сервер и страницу. Две копии расходились (ревью 28.09, F-230): страница
 * ставила число на скилл целиком, пока сервер находил шаг, а сервер сам
 * закрывал раздел шага строкой `# …` внутри блока кода и не узнавал «шаг 2».
 */

/** Заголовок пронумерованного шага: номер — группа 1, название — группа 2. */
const STEP_HEADING = /^#{2,4}\s+(?:(?:step|шаг)\s+)?(\d{1,3})\s*[.):—–-]\s*(.+?)\s*#*\s*$/iu;
const FENCE = /^\s*(`{3,}|~{3,})/;
/**
 * Шаг, названный словами: «§3», «step 3», «шаг 3». Границы — по буквам, а не
 * `\b`: у `\b` в JS «слово» только латиница, и «шаг 3» не находился никогда.
 */
const NAMED_STEP = /(?:§\s*|(?<![\p{L}\p{N}_])(?:step|шаг)\s+)(\d{1,3})(?![\p{L}\p{N}_])/iu;

export interface SkillStepHeading {
  /** Номер строки заголовка (с нуля, строки по `\r?\n`). */
  line: number;
  /** Номер шага, как написан в заголовке. */
  number: number;
  title: string;
}

/**
 * Уровень заголовка каждой строки; 0 — не заголовок. Строки блоков кода (и
 * сами ограды) — не заголовки: там бывают примеры чужой разметки и `# комментарий`
 * оболочки. Открывший забор закрывает только тот же знак не короче (CommonMark),
 * иначе «~~~» внутри «```» выпускал пример заголовка наружу (F-258).
 */
export function headingLevels(lines: readonly string[]): number[] {
  let fence: string | undefined;
  return lines.map((line) => {
    const mark = FENCE.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
      return 0;
    }
    if (fence) return 0;
    return /^(#{1,6})\s/.exec(line)?.[1]?.length ?? 0;
  });
}

/**
 * Пронумерованные шаги скилла: заголовки `## 3. Название` (уровни 2–4) вне
 * блоков кода, номера строго по возрастанию — сравнение с последним ПРИНЯТЫМ
 * шагом, а не с сырым соседом (F-257): «## 2024. Итоги» посреди текста — не шаг.
 * Меньше двух — это не порядок работы, а просто пронумерованный раздел.
 */
export function skillStepHeadings(text: string): SkillStepHeading[] {
  const lines = text.split(/\r?\n/);
  const levels = headingLevels(lines);
  const ordered: SkillStepHeading[] = [];
  lines.forEach((line, at) => {
    if (levels[at] === 0) return;
    const match = STEP_HEADING.exec(line);
    const title = match?.[2]?.trim();
    if (!match || !title) return;
    const number = Number(match[1]);
    const last = ordered.at(-1);
    if (!last || number > last.number) ordered.push({ line: at, number, title });
  });
  return ordered.length >= 2 ? ordered : [];
}

/**
 * К какому шагу скилла относится число группы — индекс в `heads` с нуля;
 * `undefined` — шаг не определить (число встанет на скилл целиком).
 *
 * Сначала раздел, в котором стоит цитата числа. Цитату модель пишет без
 * разметки и переносов, поэтому сравнение «плоское» (`knobPlainText`) по всему
 * тексту, строки через пробел. Берутся все вхождения, не первое: та же фраза во
 * вступлении иначе уводила число с шага, где оно живёт (F-222). Цитата только
 * во вступлении часто сама (или её строка) называет шаг («… in §9») — тогда он.
 *
 * `heads` — шаги, по которым считается индекс: сервер отдаёт шаги своего пути,
 * чтобы индекс числа совпадал с индексом строки пути.
 */
export function knobStepOf(
  text: string,
  quote: string,
  heads: readonly Pick<SkillStepHeading, 'line' | 'number'>[] = skillStepHeadings(text),
): number | undefined {
  if (heads.length === 0) return undefined;
  const wanted = knobPlainText(quote);
  if (!wanted) return undefined;
  const lines = text.split(/\r?\n/);
  const levels = headingLevels(lines);
  // Строки по одной в «плоском» виде с началом каждой — чтобы найденное место
  // вернуть к номеру строки.
  let flat = '';
  const starts: number[] = [];
  for (const line of lines) {
    starts.push(flat.length);
    flat += `${knobPlainText(line)} `;
  }
  const places: number[] = [];
  for (let at = flat.indexOf(wanted); at >= 0; at = flat.indexOf(wanted, at + 1)) places.push(at);
  if (places.length === 0) return undefined;
  const lineOf = (at: number): number => {
    let found = 0;
    while (found + 1 < starts.length && starts[found + 1]! <= at) found += 1;
    return found;
  };
  // Раздел шага закрыт до строки `at`, если между ними заголовок не глубже
  // шага («## Red flags» после «## 14. Report») — цитата уже не в шаге.
  const closedBefore = (head: number, at: number): boolean => {
    const own = levels[head] ?? 0;
    for (let index = head + 1; index <= at; index += 1) {
      const other = levels[index] ?? 0;
      if (other > 0 && other <= own) return true;
    }
    return false;
  };
  for (const at of places) {
    const inLine = lineOf(at);
    const section = heads.findLastIndex((head) => head.line <= inLine);
    if (section >= 0 && !closedBefore(heads[section]!.line, inLine)) return section;
  }
  const line = lineOf(places[0]!);
  const named = NAMED_STEP.exec(`${quote} ${lines[line] ?? ''}`)?.[1];
  if (named === undefined) return undefined;
  const byNumber = heads.findIndex((head) => head.number === Number(named));
  return byNumber >= 0 ? byNumber : undefined;
}
