import type { SplitConveyorStore } from './split-conveyor.ts';
import type { MrStates } from '../integrations/mr-state.ts';

/**
 * Влит ли MR группы — пока человек СМОТРИТ на хаб (владелец 06.10.2026).
 *
 * Наблюдатель MR (`mr-watch.ts`) смотрит по расписанию до суток после «готово»
 * и замолкает; MR, влитый на второй день, оставался в хабе «мержить 2-м из 4»
 * с кнопкой «Перепроверить». Опрос по таймеру на все планы гонял бы фордж и
 * тогда, когда хаб никто не открывал. Поэтому повод — само чтение хаба: пульт
 * и так спрашивает дерево каждые 5 с, и это чтение будит проверку не чаще раза
 * в `MR_STATE_TTL_MS` на план. Спрашивается только состояние, одним запросом на
 * проект (`mr-state.ts`); MR влит или закрыт — запись это помнит, и его больше
 * не спрашивают (закрытый — спрашивают: его могут открыть снова). Не о чем
 * спрашивать — запроса нет вовсе.
 *
 * Проверка идёт фоном: ответ хаба её не ждёт, новое состояние приедет со
 * следующим опросом дерева.
 */

export const MR_STATE_TTL_MS = 5 * 60_000;

export interface MrStateRefreshDeps {
  store: Pick<SplitConveyorStore, 'get' | 'set'>;
  /** Состояния MR по ссылкам; `undefined` — читать нечем (нет токена, фордж выключен). */
  read: (urls: string[]) => Promise<MrStates | undefined>;
  now?: () => number;
  log: (message: string, error?: unknown) => void;
}

export class MrStateRefresh {
  private readonly deps: MrStateRefreshDeps;
  private readonly now: () => number;
  /** План → когда его спрашивали в последний раз (и неудачно тоже). */
  private readonly asked = new Map<string, number>();
  private readonly busy = new Set<string>();

  constructor(deps: MrStateRefreshDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Хаб плана прочитан. Пора — проверка уходит фоном; нет — ничего. */
  touch(parentChatId: string): void {
    if (this.busy.has(parentChatId)) return;
    const last = this.asked.get(parentChatId);
    if (last !== undefined && this.now() - last < MR_STATE_TTL_MS) return;
    void this.refresh(parentChatId).catch((error: unknown) => {
      this.deps.log('mr state: refresh failed', error);
    });
  }

  /** Одна проверка плана. Открыта для тестов; сама по себе зовётся из `touch`. */
  async refresh(parentChatId: string): Promise<void> {
    const urls = this.pending(parentChatId);
    if (urls.length === 0) return;
    this.busy.add(parentChatId);
    this.asked.set(parentChatId, this.now());
    try {
      const read = await this.deps.read(urls);
      if (!read) {
        // Читать нечем — это не попытка: включили фордж — следующий взгляд на
        // хаб спросит сразу, а не через пять минут.
        this.asked.delete(parentChatId);
        return;
      }
      for (const error of read.failed) this.deps.log('mr state: forge read failed', error);
      this.apply(parentChatId, read.states);
    } finally {
      this.busy.delete(parentChatId);
    }
  }

  /** MR плана, состояние которых ещё может поменяться. */
  private pending(parentChatId: string): string[] {
    const record = this.deps.store.get(parentChatId);
    if (!record) return [];
    const urls = record.groups
      .filter((group) => group.mr && group.mrClosed !== 'merged')
      .map((group) => group.mr as string);
    return [...new Set(urls)];
  }

  /** Записать прочитанное в СВЕЖУЮ запись: за время запроса её могли поменять. */
  private apply(parentChatId: string, states: Map<string, string>): void {
    const record = this.deps.store.get(parentChatId);
    if (!record) return;
    let changed = false;
    for (const group of record.groups) {
      const state = group.mr ? states.get(group.mr) : undefined;
      if (!state) continue;
      if (state === 'merged' || state === 'closed') {
        if (group.mrClosed === state) continue;
        group.mrClosed = state;
        changed = true;
      } else if (group.mrClosed) {
        // Закрытый MR открыли снова — группа опять ждёт слияния.
        delete group.mrClosed;
        changed = true;
      }
    }
    if (changed) this.deps.store.set(record);
  }
}
