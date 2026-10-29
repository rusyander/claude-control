import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { LiveTask } from '../../../journal/resume.ts';
import type { KillPoint } from './e2e.types.ts';

type Listener = Parameters<LiveTask['subscribe']>[0];
type TaskState = Parameters<Listener>[1];

/**
 * Точки смерти на решениях о праве (P10). Хук ядра решает КАЖДЫЙ вызов инструмента, а вопрос
 * CLI (инструмент права, своя полоса Qwen) приходит следом за ним — счёт всех решений подряд
 * положил бы точки 1–3 на первые один-два вызова. Вопросы считаются отдельно (`tool`, те же
 * вызовы, что до дороги сессии), хук — своей точкой.
 */
export const PERMIT_KILL_POINTS: { name: string; kill: Extract<KillPoint, { at: 'journal' }> }[] = [
  ...[1, 2, 3].map((nth) => ({
    name: `permit decision ${nth}`,
    kill: {
      at: 'journal' as const,
      kind: 'decision' as const,
      nth,
      decisionClass: 'permit',
      decisionRoad: 'tool' as const,
    },
  })),
  {
    name: 'hook decision 1',
    kill: {
      at: 'journal',
      kind: 'decision',
      nth: 1,
      decisionClass: 'permit',
      decisionRoad: 'hook',
    },
  },
];

/**
 * Счётчик точки смерти `journal`: `true` ровно на `nth`-й строке, подходящей под точку (вид,
 * действие, класс решения, дорога решения о праве). Чистый — сквозной прогон умирает по нему, а
 * тест проверяет, на какой вызов инструмента ложится каждая точка.
 */
export function journalKillHit(
  kill: Extract<KillPoint, { at: 'journal' }>,
): (line: JournalLine, state: TaskState) => boolean {
  let seen = 0;
  return (line, state) => {
    if (line.kind !== kill.kind) return false;
    if (kill.action) {
      const id = (line.data as { actionId?: string }).actionId;
      if (!id || state.actions[id]?.kind !== kill.action) return false;
    }
    if (kill.decisionClass && (line.data as { class?: string }).class !== kill.decisionClass) {
      return false;
    }
    if (kill.decisionRoad) {
      const road = (line.data as { output?: { road?: string } }).output?.road;
      if ((road === 'hook' ? 'hook' : 'tool') !== kill.decisionRoad) return false;
    }
    seen += 1;
    return seen === kill.nth;
  };
}
