import type { CliRunFacts } from './types.ts';

/**
 * Лестница уровня шага ядра (03 §Economy) по фактам CLI: модели от слабой к сильной — имена,
 * которые CLI принимает (`modelRungs[].model`), с приставками полных имён той же ступени по
 * индексу, и усилие от низкого к высокому (`effort.values`). Своей копии значений здесь нет:
 * лестница — проекция тех же фактов, что запуск и каталог панели.
 */
export interface TierLadderFacts {
  models: string[];
  /** Другие имена ступени `models[i]` — приставки полных id; ранг у них тот же. */
  aliases: string[][];
  efforts: string[];
  /** Потолок автоматики (`CliRunFacts.autoCeiling`): эскалация и обучение выше не поднимают. */
  autoCeiling?: string;
}

/** `undefined` — у CLI нет ни ступеней модели, ни глубины: сравнить и сдвинуть нечем. */
export function tierLadderOf(facts: CliRunFacts): TierLadderFacts | undefined {
  const rungs = facts.modelRungs ?? [];
  const efforts = facts.effort?.values ?? [];
  if (rungs.length === 0 && efforts.length === 0) return undefined;
  // Потолок — только ступень этой же лестницы: имя вне её ничего бы не ограничило молча.
  const ceiling = rungs.some((rung) => rung.model === facts.autoCeiling)
    ? { autoCeiling: facts.autoCeiling as string }
    : {};
  return {
    models: rungs.map((rung) => rung.model),
    aliases: rungs.map((rung) => [...rung.ids]),
    efforts: [...efforts],
    ...ceiling,
  };
}
