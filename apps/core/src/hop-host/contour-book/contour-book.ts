import type {
  PlatformExhaustedScope,
  PlatformGatewayEvent,
  PlatformSpendRecord,
  PlatformUsageRecord,
} from '@agentdeck/contracts';
import type { HopBudgetNotice } from '@agentdeck/contracts/core/hops';
import {
  addSpend,
  budgetCrossing,
  emptySpend,
  type SpendDelta,
} from '@agentdeck/pricing/contour-spend';
import { readJsonFile, writeJsonFile } from '../gateway/json-file.ts';
import type { PanelContours } from './panel-state.ts';

/**
 * Учёт контуров на звене (этап 10, C3b): то, что раньше держал шлюз в панели, — след запросов
 * (последние 50), расход по контуру от запуска, счётчики, постоянные дни расхода и отметка
 * «контур отказал по бюджету» с тем, что назвал манифест. Звено — единственный писатель:
 * через него идут шлюз человека и сеансы ядра; записи снаружи нет (проверки засевают учёт
 * настоящим запросом через шлюз). Панель и ядро читают, сами не считают.
 *
 * Дни копятся в памяти и уходят на диск пачкой (как `spend-flush` панели): ответ модели не
 * ждёт бухгалтерию. Отказ по бюджету пишется СРАЗУ — это факт, и он переживает перезапуск.
 * Контур, которого в панели уже нет, расход не воскрешает: id могут занять заново.
 */

/** Сколько последних запросов помнит след: столько же, сколько держал шлюз в панели. */
export const CONTOUR_EVENTS_KEPT = 50;
/** Файл постоянного учёта в каталоге состояния звена (не в `spend/`: там файлы меток). */
export const CONTOUR_SPEND_FILE = 'contour-spend.json';
/** Потолок очереди одного контура, пока диск не принимает запись. */
const MAX_PENDING = 1_000;

export interface ContourRefusal {
  scope: PlatformExhaustedScope;
  level?: string;
}

export interface ContourSnapshot {
  /** С какого момента звено считает (запуск хоста). */
  since: number;
  requests: number;
  failures: number;
  usage: PlatformUsageRecord[];
  /** Новые сверху. */
  events: PlatformGatewayEvent[];
  /** Перейдённые пороги бюджета, по возрастанию `seq`. */
  notices: HopBudgetNotice[];
}

/** Сколько извещений о бюджете помнит звено: читатель забирает их каждые несколько секунд. */
export const BUDGET_NOTICES_KEPT = 50;

interface StoredBook {
  v: 1;
  records: Record<string, PlatformSpendRecord>;
  notices?: HopBudgetNotice[];
}

interface Pending {
  delta: SpendDelta;
  at: Date;
}

export class ContourBook {
  readonly #file: string;
  readonly #panel: PanelContours;
  readonly #since: number;
  #records: Record<string, PlatformSpendRecord>;
  #notices: HopBudgetNotice[];
  #pending = new Map<string, Pending[]>();
  #events: PlatformGatewayEvent[] = [];
  #usage = new Map<string, PlatformUsageRecord>();
  #requests = 0;
  /** В памяти есть то, чего ещё нет на диске (прошлая запись не удалась). */
  #dirty = false;
  #failures = 0;

  constructor(file: string, panel: PanelContours, now: number) {
    this.#file = file;
    this.#panel = panel;
    this.#since = now;
    const stored = this.#read();
    this.#records = stored?.records ?? {};
    this.#notices = stored?.notices ?? [];
    // Первый запуск учёта на машине: дни, которые вела панель (`state.json` → `platformSpend`),
    // переезжают сюда один раз — до первого запроса, поэтому сложить нечего и затереть некого.
    // Отметки сказанных порогов едут с записью: панель уже сказала о них людям.
    if (!stored) {
      const legacy = panel.legacySpend();
      if (Object.keys(legacy).length > 0) {
        this.#records = legacy;
        this.#write();
      }
    }
  }

  /** След одного запроса (новые сверху). */
  event(event: PlatformGatewayEvent): void {
    this.#requests += 1;
    if (event.status >= 400) this.#failures += 1;
    this.#events.unshift(event);
    if (this.#events.length > CONTOUR_EVENTS_KEPT) this.#events.length = CONTOUR_EVENTS_KEPT;
  }

  /**
   * Расход одного ответа: живой счётчик от запуска и день постоянного учёта. Пустой расход
   * (оборванный поток, отказ до модели) дня не заводит — кроме ответа, дошедшего без счёта
   * (`unreported`): он копится отдельным счётчиком, без выдуманных токенов.
   */
  usage(platformId: string, delta: SpendDelta, at: Date): void {
    // Живой счётчик считает каждый ответ, и пустой тоже (как `GatewayJournal` панели).
    const current = this.#usage.get(platformId);
    this.#usage.set(platformId, {
      platformId,
      requests: (current?.requests ?? 0) + 1,
      promptTokens: (current?.promptTokens ?? 0) + delta.promptTokens,
      completionTokens: (current?.completionTokens ?? 0) + delta.completionTokens,
      totalTokens: (current?.totalTokens ?? 0) + delta.totalTokens,
      at: at.toISOString(),
    });
    if (delta.totalTokens <= 0 && !delta.unreported) return;
    const queue = this.#pending.get(platformId) ?? [];
    queue.push({ delta, at });
    if (queue.length > MAX_PENDING) queue.splice(0, queue.length - MAX_PENDING);
    this.#pending.set(platformId, queue);
  }

  /**
   * Контур отказал по бюджету (402). Прежние scope и уровень не наследуются: новый отказ без
   * названия поверх старого с названием выдавал бы старое за новое.
   */
  exhausted(platformId: string, at: Date, refusal?: ContourRefusal): void {
    if (!this.#panel.known(platformId)) return;
    this.#settle();
    const record = { ...(this.#records[platformId] ?? emptySpend(platformId)) };
    delete record.exhaustedScope;
    delete record.exhaustedLevel;
    this.#records[platformId] = {
      ...record,
      exhaustedAt: at.toISOString(),
      ...(refusal ? { exhaustedScope: refusal.scope } : {}),
      ...(refusal?.level ? { exhaustedLevel: refusal.level } : {}),
    };
    this.#write();
  }

  /** Снять отметку «исчерпан» (человек продлил бюджет). `false` — снимать было нечего. */
  clearExhausted(platformId: string): boolean {
    this.#settle();
    const record = this.#records[platformId];
    if (!record?.exhaustedAt) return false;
    const next = { ...record };
    delete next.exhaustedAt;
    delete next.exhaustedScope;
    delete next.exhaustedLevel;
    // Ручной сброс — второй и последний повод снять отметки объявленных порогов (первый —
    // смена `budgetSince`): человек продлил бюджет, следующий переход порога обязан прозвучать.
    delete next.announcedBudget;
    this.#records[platformId] = next;
    this.#write();
    return true;
  }

  snapshot(): ContourSnapshot {
    return {
      since: this.#since,
      requests: this.#requests,
      failures: this.#failures,
      usage: [...this.#usage.values()],
      events: [...this.#events],
      notices: [...this.#notices],
    };
  }

  /** Постоянный учёт; накопленное в памяти уже сложено — читатель видит последнюю цифру. */
  records(): Record<string, PlatformSpendRecord> {
    // Контур удалён в панели — его расход уходит с ним (как `forgetPlatformSpend` панели):
    // id могут занять заново, и новый контур не должен начать с чужих дней.
    for (const platformId of Object.keys(this.#records)) {
      if (this.#panel.known(platformId)) continue;
      delete this.#records[platformId];
      this.#dirty = true;
    }
    this.flush();
    return structuredClone(this.#records);
  }

  /** Сбросить накопленное на диск; пусто — файл не трогаем. */
  flush(): void {
    // compromise: telemetry-local — приёма телеметрии от клиента у контура нет: расход пишется к себе на машину и никуда не отправляется
    if (this.#pending.size === 0 && !this.#dirty) return;
    this.#settle();
    this.#write();
  }

  /** Сложить очередь в дни (в памяти); контур, которого нет в панели, отбрасывается. */
  #settle(): void {
    const pending = this.#pending;
    this.#pending = new Map();
    for (const [platformId, queue] of pending) {
      if (!this.#panel.known(platformId)) continue;
      const lookup = this.#panel.lookup(platformId);
      let record = this.#records[platformId] ?? emptySpend(platformId);
      for (const item of queue) record = addSpend(record, item.delta, item.at, lookup);
      this.#records[platformId] = this.#announce(record, queue.at(-1)?.at ?? new Date());
    }
  }

  /**
   * Порог бюджета, перейдённый этой пачкой (`budgetCrossing`, правило панели): отметка о
   * сказанном ложится в запись и уезжает на диск той же записью, что и расход, — перезапуск
   * звена не повод повторить сказанное. Извещение читают каналы панели по `seq`.
   */
  #announce(record: PlatformSpendRecord, at: Date): PlatformSpendRecord {
    const budget = this.#panel.budget(record.platformId);
    const crossing = budget ? budgetCrossing(budget, record) : undefined;
    if (!crossing || !budget) return record;
    this.#notices.push({
      seq: (this.#notices.at(-1)?.seq ?? 0) + 1,
      at: at.toISOString(),
      platformId: record.platformId,
      platformTitle: budget.title,
      level: crossing.level,
      share: crossing.share,
    });
    if (this.#notices.length > BUDGET_NOTICES_KEPT)
      this.#notices.splice(0, this.#notices.length - BUDGET_NOTICES_KEPT);
    return crossing.record;
  }

  #write(): void {
    this.#dirty = true;
    try {
      writeJsonFile(this.#file, {
        v: 1,
        records: this.#records,
        notices: this.#notices,
      } satisfies StoredBook);
      this.#dirty = false;
    } catch (error) {
      // Учёт не роняет звено: в памяти всё осталось, следующий сброс попробует снова.
      process.stderr.write(
        `contour spend not written (${error instanceof Error ? error.message : error})\n`,
      );
    }
  }

  /** `undefined` — файла учёта ещё нет (первый запуск); битый файл — пустой учёт, не перенос. */
  #read(): Pick<StoredBook, 'records' | 'notices'> | undefined {
    try {
      const stored = readJsonFile<StoredBook | undefined>(this.#file, undefined);
      if (stored === undefined) return undefined;
      if (stored?.v !== 1 || !stored.records) return { records: {} };
      return {
        records: stored.records,
        ...(Array.isArray(stored.notices) ? { notices: stored.notices } : {}),
      };
    } catch {
      return { records: {} };
    }
  }
}
