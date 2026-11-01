import type { JournalKind, JournalLine } from '@agentdeck/contracts/core/journal';
import type { PredicateCtx } from '../observer.types.ts';

/**
 * Самопроверка предиката (P33, каталог этапа 8): журнал, на котором сигнал ОБЯЗАН сработать, и
 * его почти-двойник, на котором обязан молчать. Каждая папка предикатов кладёт свои пары в
 * `observer/<папка>/__fixtures__/selftests.ts` (`export const SELFTESTS: SelftestPair[]`):
 * `catalog.test.ts` находит файлы сам и гонит каждую пару через `foldObserver` со ВСЕМИ
 * предикатами реестра — сигнал без пары или пара, которая не краснеет, краснит каталог.
 */
export interface SelftestPair {
  signal: string;
  /** Журнал, на котором сигнал выходит (хотя бы один вердикт с этим id). */
  fires: readonly JournalLine[];
  /** Почти-двойник: ни одного вердикта с этим id. */
  silent: readonly JournalLine[];
  /** Окно маршрута в токенах для обеих сторон; нет — неизвестно (`null`). */
  windowOf?: PredicateCtx['windowOf'];
}

const TASK = '01900000-0000-7000-8000-000000000000';
const BOOT = '01900000-0000-7000-8000-0000000000b0';

/** Строка журнала для пары: `seq` по порядку, прочие поля конверта — постоянные. */
export function journalLines(
  rows: readonly {
    kind: JournalKind;
    data: unknown;
    stepId?: string;
    sessionId?: string;
    cause?: number;
  }[],
): JournalLine[] {
  return rows.map(
    (r, i) =>
      ({
        v: 1,
        seq: i + 1,
        at: 1_700_000_000_000 + i,
        mono: (i + 1) * 10,
        bootId: BOOT,
        taskId: TASK,
        actor: 'core',
        ...(r.stepId ? { stepId: r.stepId } : {}),
        ...(r.sessionId ? { sessionId: r.sessionId } : {}),
        ...(r.cause ? { cause: r.cause } : {}),
        kind: r.kind,
        data: r.data,
      }) as JournalLine,
  );
}
