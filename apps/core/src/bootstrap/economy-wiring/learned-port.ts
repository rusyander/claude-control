import type { LearnedKey } from '@agentdeck/contracts/core/economy';
import { keyOf, learnedPathsFor, resetLearnedKey } from '../../economy/learned/index.ts';

/**
 * Порт сброса ключа обучения (этап 11, P140) для `POST /v1/learned/reset`: сброс пишется в
 * долговечный файл сбросов дома ядра (`learned-resets.json`, не кэш — удаление или новая версия
 * кэша сброс не снимают), строка журнала ядра называет кто и что сбросил, выученное
 * перечитывается — следующий же суд `tier` идёт без снятого подъёма.
 */

export type LearnedNote = (event: string, data: Record<string, unknown>) => void;

export function learnedPortOf(deps: {
  tasksDir: string;
  note: LearnedNote;
  /** Перечитать выученное после сброса (`bootEconomy().history`). */
  refresh: () => void;
  now?: () => number;
}): {
  reset(key: LearnedKey, meta: { cmdId: string; by: string }): { key: string; at: number };
  refused(cmdId: string, code: string): void;
} {
  const now = deps.now ?? Date.now;
  return {
    reset(key, meta) {
      const row = keyOf(key);
      const at = now();
      resetLearnedKey(learnedPathsFor(deps.tasksDir).resetsFile, row, { at, cmdId: meta.cmdId });
      deps.note('learned.reset', { ...meta, key: row, at });
      deps.refresh();
      return { key: row, at };
    },
    refused: (cmdId, code) => deps.note('learned.refused', { cmdId, code }),
  };
}
