import type { CliRunFacts } from './types.ts';

/** Место значения в шаблоне argv глубины. */
const EFFORT_SLOT = '{effort}';

/**
 * Значение глубины, которое CLI примет, иначе `undefined`. Незнакомое не передаётся вовсе:
 * выдуманный уровень уронил бы прогон целиком, а «ничего не сказали» значит «как настроено
 * у человека» — рабочее состояние.
 */
export function acceptedEffort(facts: CliRunFacts, effort: string | undefined): string | undefined {
  if (!effort || !facts.effort) return undefined;
  return facts.effort.values.includes(effort) ? effort : undefined;
}

/** Аргументы глубины для argv; глубины нет или значение чужое — пустой список. */
export function effortArgs(facts: CliRunFacts, effort: string | undefined): string[] {
  const value = acceptedEffort(facts, effort);
  if (value === undefined || !facts.effort) return [];
  return facts.effort.argv.map((part) => part.replace(EFFORT_SLOT, value));
}
