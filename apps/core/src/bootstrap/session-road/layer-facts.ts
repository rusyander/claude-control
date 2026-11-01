import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import type { CliAdapter } from '../../adapters/adapter.types.ts';
import { modelRank as rankOnLadder } from '../../economy/tier-ladder.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Факты слоя человека у сеанса для судьи права (06:115, 06:124, G5) и крана слоя: режим навыков,
 * подагенты, опись слоя. Опись считает старт сеанса (`journalLayerStart`); сеанс прежнего ядра,
 * прикреплённый заново, считает её лениво — с тем слоем репозитория, с которым он запущен на деле
 * (`session.started.layer`), один раз за жизнь сеанса в этом процессе.
 */

export interface SessionLayerBook {
  /** Опись, посчитанная стартом сеанса (`null` — переходник описи не даёт). */
  started(sessionId: string, inventory: UserLayerInventory | null): void;
  /** Поля слоя `PermitContext`; заодно ставит ленивую опись сеанса, если старт её ещё не дал. */
  context(
    start: RoadStart,
    adapter: CliAdapter | undefined,
  ): Pick<PermitContext, 'layer' | 'subagents'>;
  /** Опись сеанса для крана слоя; сеанса нет в книге — `null` (кандидатов отказа нет). */
  inventoryOf(sessionId: string): UserLayerInventory | null;
  forget(sessionId: string): void;
}

/**
 * Слой репозитория сеанса из его `session.started`. Строки нет или в ней нет слоя — `true`: опись
 * с определениями репозитория строже (больше определений подагентов судится по их модели).
 */
function repoLayerOf(task: LiveTask, sessionId: string): boolean {
  const line = readJournalLines(task.dir, task.taskId).lines.find(
    (l) => l.kind === 'session.started' && l.sessionId === sessionId,
  ) as JournalLine<'session.started'> | undefined;
  return line?.data.layer?.repoLayer ?? true;
}

function once<T>(read: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = read();
      done = true;
    }
    return value;
  };
}

export function createSessionLayerBook(): SessionLayerBook {
  const book = new Map<string, () => UserLayerInventory | null>();
  const inventoryOf = (sessionId: string): UserLayerInventory | null => {
    const read = book.get(sessionId);
    if (!read) return null;
    try {
      return read();
    } catch {
      // Опись не прочлась (журнал, файлы слоя) — определений не знаем: судится модель вызова.
      return null;
    }
  };
  return {
    started(sessionId, inventory) {
      book.set(sessionId, () => inventory);
    },
    context(start, adapter) {
      const { task, sessionId } = start;
      if (!book.has(sessionId)) {
        const inventory = adapter?.inventory;
        book.set(
          sessionId,
          once(() =>
            inventory ? inventory(start.pin, start.cwd, repoLayerOf(task, sessionId)) : null,
          ),
        );
      }
      // Ранг модели — лестница переходника сеанса (факты запуска CLI): алиас и полное имя одной
      // модели — одна ступень. Лестницы нет — ранг неизвестен, подагент с названной моделью
      // отказывается, с моделью сеанса идёт. Потолка нет — сравнение с моделью шага (R8).
      const ladder = adapter?.ladder;
      const modelRank = (model: string): number | null => rankOnLadder(ladder, model);
      const ceiling = task.state.created?.modelCeiling ?? start.model;
      // `subagentHooks` по контракту — и хук ядра, и запреты держатся внутри подагента (проба G5).
      const holds = adapter?.caps.subagentHooks === true;
      return {
        layer: { skills: start.layer.skills },
        subagents: {
          allowed: holds,
          ceilingRank: ceiling === null ? null : modelRank(ceiling),
          modelRank,
          definitionModel: (type) =>
            inventoryOf(sessionId)?.agents.find((a) => a.name === type)?.model ?? null,
          readOnlyHolds: holds,
        },
      };
    },
    inventoryOf,
    forget(sessionId) {
      book.delete(sessionId);
    },
  };
}
