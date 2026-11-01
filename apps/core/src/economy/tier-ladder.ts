import type { TierLadder } from './tier.types.ts';

/**
 * Лестница модели и усилия (03 §Economy): ступень модели и усилия, подъём усилия плана. Имена
 * ступеней — данные переходника; здесь только два закреплённых спецификацией слова усилия:
 * потолок подъёма и запрет. Сопоставление с шаблоном маршрута живёт в `tier.ts` (P32 allow-list).
 */

/** Подъём усилия плана доходит до этой ступени, не выше (03:143). */
export const EFFORT_RAISE_CAP = 'xhigh';
/** Это усилие ядро само не выбирает никогда (03:143 «never max»): только правка человека. */
export const EFFORT_NEVER = 'max';

/** Виды шагов, которым уровень `raise-for-planning` поднимает усилие (03:142). */
export const PLANNING_KINDS: ReadonlySet<string> = new Set(['plan', 'split', 'research']);

/**
 * Ступень модели: точное имя или самое длинное семейство-префикс — среди имени ступени и её
 * других имён (`aliases`: алиас и полный id одной модели — одна ступень). `null` — модели нет на
 * лестнице (или модель по умолчанию CLI): сравнить нечем.
 */
export function modelRank(ladder: TierLadder | undefined, model: string | null): number | null {
  if (!ladder || model === null) return null;
  let rank: number | null = null;
  let len = -1;
  ladder.models.forEach((name, i) => {
    for (const entry of [name, ...(ladder.aliases?.[i] ?? [])]) {
      if (model !== entry && !model.startsWith(entry)) continue;
      if (entry.length > len) {
        rank = i;
        len = entry.length;
      }
    }
  });
  return rank;
}

export function effortRank(ladder: TierLadder | undefined, effort: string | null): number | null {
  if (!ladder || effort === null) return null;
  const rank = ladder.efforts.indexOf(effort);
  return rank < 0 ? null : rank;
}

/** Высшая ступень усилия, которую ядро вправе выбрать само: потолок подъёма, никогда запрет. */
export function topEffort(ladder: TierLadder | undefined): string | null {
  if (!ladder) return null;
  const cap = ladder.efforts.indexOf(EFFORT_RAISE_CAP);
  const allowed = ladder.efforts.filter((e, i) => e !== EFFORT_NEVER && (cap < 0 || i <= cap));
  return allowed[allowed.length - 1] ?? null;
}
