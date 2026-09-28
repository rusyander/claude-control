import type { KnobView, PathEntry } from '@agentdeck/contracts';
import { skillTextSteps, stepOfQuote } from './skillText';

/**
 * Строка вкладки «Порядок работы». Почти всегда — строка пути с сервера; но у
 * скилла-участника с настраиваемыми числами и без пронумерованных шагов в пути
 * нет ни одной строки, и его числам негде было бы стоять. Такой скилл получает
 * свою строку «скилл целиком» — там же, где сервер ставит шаги скиллов: после
 * стадии работы.
 */
export type PathRow =
  | {
      kind: 'entry';
      key: string;
      entry: PathEntry;
      /** Индекс в `entries` — «+» после строки вставляет шаг после него. */
      entryIndex: number;
      knobs: KnobView[];
    }
  | { kind: 'skill'; key: string; skillId: string; entryIndex: number; knobs: KnobView[] };

/** Сервер ставит шаги скиллов после этой стадии (`SKILL_STEPS_AFTER`). */
const SKILLS_AFTER = 'work';

/**
 * Строки пути с числами на своих местах. Число относится к шагу, в разделе
 * которого стоит его цитата (`step` от сервера, иначе свой разбор); шага нет или цитата
 * вне разделов — к первому шагу скилла.
 */
export function buildPathRows(
  entries: PathEntry[],
  knobs: KnobView[],
  skillText: (skillId: string) => string | undefined,
): PathRow[] {
  const bySkill = new Map<string, KnobView[]>();
  for (const knob of knobs) bySkill.set(knob.skillId, [...(bySkill.get(knob.skillId) ?? []), knob]);

  const placed = new Map<number, KnobView[]>();
  const whole: string[] = [];
  for (const [skillId, list] of bySkill) {
    const own = entries.flatMap((entry, index) =>
      entry.kind === 'skill-step' && entry.skillId === skillId ? [{ entry, index }] : [],
    );
    const first = own[0];
    if (!first) {
      // Скилл вошёл шагом-ссылкой (так скиллы стоят в сценарии) — его числа
      // стоят в этой строке, отдельная строка «скилл целиком» была бы дублем.
      const reference = entries.findIndex(
        (entry) =>
          entry.kind === 'custom' &&
          entry.step.resource?.type === 'skill' &&
          entry.step.resource.id === skillId,
      );
      if (reference >= 0) placed.set(reference, [...(placed.get(reference) ?? []), ...list]);
      else whole.push(skillId);
      continue;
    }
    const text = skillText(skillId);
    const steps = text ? skillTextSteps(text) : [];
    for (const knob of list) {
      // Шаг числа считает сервер (у него есть текст и проектного скилла); свой
      // разбор — только для ответа без поля.
      const step =
        knob.step ??
        (text && steps.length === own.length ? stepOfQuote(steps, text, knob.quote) : undefined);
      const target =
        own.find((item) => item.entry.kind === 'skill-step' && item.entry.index === step) ?? first;
      placed.set(target.index, [...(placed.get(target.index) ?? []), knob]);
    }
  }

  const rows: PathRow[] = entries.map((entry, index) => ({
    kind: 'entry',
    key: entryKey(entry, index),
    entry,
    entryIndex: index,
    knobs: placed.get(index) ?? [],
  }));
  if (whole.length === 0) return rows;

  const after = skillsEnd(entries);
  const wholeRows: PathRow[] = whole.map((skillId) => ({
    kind: 'skill',
    key: `whole:${skillId}`,
    skillId,
    entryIndex: after,
    knobs: bySkill.get(skillId) ?? [],
  }));
  return [...rows.slice(0, after + 1), ...wholeRows, ...rows.slice(after + 1)];
}

/** Последняя строка блока скиллов: стадия работы и шаги скиллов сразу за ней. */
function skillsEnd(entries: PathEntry[]): number {
  let at = entries.findIndex((entry) => entry.kind === 'builtin' && entry.stage === SKILLS_AFTER);
  if (at < 0) return entries.length - 1;
  while (entries[at + 1]?.kind === 'skill-step') at += 1;
  return at;
}

export function entryKey(entry: PathEntry, index: number): string {
  if (entry.kind === 'builtin') return `builtin:${entry.stage}`;
  if (entry.kind === 'custom') return `custom:${entry.step.id}`;
  return `skill:${entry.skillId}:${entry.index}:${index}`;
}

/** Сколько шагов у группы сверх встроенных стадий — число на карточке. */
export function ownStepCount(entries: PathEntry[]): number {
  return entries.filter((entry) => entry.kind !== 'builtin').length;
}

/**
 * Есть ли «+» после строки `index`. Между любыми двумя строками — да: рядом с
 * шагами скилла вставка идёт внутрь его порядка (`slotAfter`). Нет только
 * перед строкой «скилл целиком»: у такого скилла нет шагов, между которыми
 * встать, и шаг ушёл бы ниже неё — «+» соврал бы о месте.
 */
export function canInsertAfter(rows: PathRow[], index: number): boolean {
  return rows[index + 1]?.kind !== 'skill';
}
