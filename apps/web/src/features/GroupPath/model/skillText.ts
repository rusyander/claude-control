/**
 * Разметка текста скилла на шаги. Какие заголовки — шаги, решает общий со
 * сервером разбор (`@agentdeck/contracts/skill-steps`): совпадать обязано до
 * шага — по порядковому номеру отсюда строка пути находит своё описание, а число
 * скилла — строку, к которой оно относится. Здесь только границы разделов.
 */
import { headingLevels, knobStepOf, skillStepHeadings } from '@agentdeck/contracts/skill-steps';

export interface SkillTextStep {
  title: string;
  /** Номер строки заголовка (с нуля). */
  line: number;
  /** Номер шага, как написан в заголовке. */
  number: number;
  /** Смещение строки заголовка в тексте. */
  start: number;
  /** Где кончается раздел шага: следующий шаг или заголовок не глубже. */
  end: number;
  /** Текст раздела без заголовка. */
  body: string;
}

/**
 * Разобранные тексты скиллов — по тексту: строк пути у одного скилла десятки,
 * и каждая при каждой отрисовке разбирала тот же текст заново. Скиллов в окне
 * немного, поэтому хватает небольшого запаса; старейший уходит первым.
 */
const parsed = new Map<string, SkillTextStep[]>();
const PARSED_LIMIT = 16;

/** Шаги скилла по порядку; меньше двух — это не порядок работы, а просто раздел. */
export function skillTextSteps(text: string): SkillTextStep[] {
  const cached = parsed.get(text);
  if (cached) return cached;
  const steps = parseSteps(text);
  if (parsed.size >= PARSED_LIMIT) parsed.delete(parsed.keys().next().value as string);
  parsed.set(text, steps);
  return steps;
}

function parseSteps(text: string): SkillTextStep[] {
  const heads = skillStepHeadings(text);
  if (heads.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const levels = headingLevels(lines);
  // Смещение начала каждой строки в исходном тексте: делит строки `\n`, а `\r`
  // остаётся в длине строки — те же номера строк, что у общего разбора.
  const starts: number[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    starts.push(offset);
    offset += raw.length + 1;
  }
  const isStep = new Set(heads.map((head) => head.line));
  return heads.map((head) => {
    // Раздел кончается на следующем шаге или на заголовке не глубже этого.
    const own = levels[head.line] ?? 0;
    let next = head.line + 1;
    while (next < lines.length) {
      const level = levels[next] ?? 0;
      if (isStep.has(next) || (level > 0 && level <= own)) break;
      next += 1;
    }
    const end = starts[next] ?? text.length;
    return {
      title: head.title,
      line: head.line,
      number: head.number,
      start: starts[head.line] ?? 0,
      end,
      body: text.slice(starts[head.line + 1] ?? text.length, end).trim(),
    };
  });
}

/**
 * К какому шагу относится цитата числа — тот же разбор, что у сервера
 * (`knobStep`): раздел, в котором стоит цитата (любое её вхождение, не первое),
 * иначе шаг, названный во вступлении («§3», «step 3», «шаг 3»). Не нашлось —
 * шага нет, число относится к скиллу целиком.
 */
export function stepOfQuote(
  steps: SkillTextStep[],
  text: string,
  quote: string,
): number | undefined {
  return knobStepOf(text, quote, steps);
}

/** Первый абзац раздела — то, что влезает в подсказку строки. */
export function firstParagraph(text: string, limit = 280): string {
  const paragraph =
    text
      .split(/\n\s*\n/)
      .map((part) => part.replace(/^#+\s*/gm, '').trim())
      .find(Boolean) ?? '';
  const flat = paragraph.replace(/\s+/g, ' ');
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}
