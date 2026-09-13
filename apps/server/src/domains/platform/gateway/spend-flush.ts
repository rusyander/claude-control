import type { PlatformExhaustedScope, PlatformSpendRecord } from '@agentdeck/contracts';
import type { AppStore } from '../../../lib/app-store.ts';
import type { PricingLookup } from '../../analytics/pricing.ts';
import { addSpend, declaredPricing, emptySpend, type SpendDelta } from '../spend.ts';
import { readPlatforms } from '../store.ts';

/**
 * Запись расхода на диск — ПАЧКОЙ, а не на каждый ответ.
 *
 * `AppStore.persist` пишет весь `state.json` синхронно. Шлюз считает расход
 * после КАЖДОГО ответа модели, и запись файла прямо там означала бы, что учёт
 * (наша бухгалтерия) тормозит чужой поток: у CLI с десятком параллельных
 * запросов это блокировка цикла событий на каждый ответ.
 *
 * Поэтому расход копится в памяти и уезжает на диск раз в несколько секунд.
 * Цена этого решения названа прямо: панель, убитая между сбросами, теряет
 * последние секунды учёта. Это меньшее из зол — потерянный ХВОСТ расхода
 * заметно дешевле, чем подтормаживающий шлюз, и точную цифру всё равно знает
 * только админка контура.
 *
 * Отказ 402 — исключение: он сбрасывается НЕМЕДЛЕННО. Это единственное точное
 * знание панели о чужом бюджете, и потерять его в перезапуске значит вернуть
 * человеку бодрое «бюджет в порядке» ровно там, где контур уже отказывает.
 */

/** Что кончилось, как это назвало тело отказа. */
export interface BudgetRefusal {
  scope: PlatformExhaustedScope;
  level?: string;
}

/** Раз во сколько сбрасываем накопленное. */
export const SPEND_FLUSH_MS = 5_000;

/**
 * Сколько неудачно записанных ответов держим в памяти на контур.
 *
 * Диск может отказывать долго (антивирус, индексатор, полный том), а шлюз всё
 * это время считает. Очередь без предела превратила бы бухгалтерию в утечку
 * памяти; потерянный ХВОСТ учёта дешевле упавшей панели, и об отброшенном
 * сказано в stderr.
 */
const MAX_PENDING = 1_000;

export interface SpendFlusherOptions {
  store: AppStore;
  /** Цены для оценки денег: свои цены человека и прайс. */
  lookup?: () => PricingLookup;
  flushMs?: number;
  now?: () => Date;
}

interface Pending {
  delta: SpendDelta;
  at: Date;
}

export class SpendFlusher {
  readonly #store: AppStore;
  readonly #lookup: () => PricingLookup;
  readonly #flushMs: number;
  readonly #now: () => Date;
  #pending = new Map<string, Pending[]>();
  #timer?: NodeJS.Timeout;

  constructor(options: SpendFlusherOptions) {
    this.#store = options.store;
    this.#lookup = options.lookup ?? (() => ({}));
    this.#flushMs = options.flushMs ?? SPEND_FLUSH_MS;
    this.#now = options.now ?? (() => new Date());
  }

  /** Прибавить расход одного ответа. На диск он уедет вместе с соседями. */
  add(platformId: string, delta: SpendDelta, at = this.#now()): void {
    // Пустой расход не копим: контур не прислал `usage` (оборванный поток,
    // отказ до модели) — считать нечего, а лишний день в записи означал бы
    // «в этот день что-то потратили».
    if (delta.totalTokens <= 0) return;
    const queue = this.#pending.get(platformId) ?? [];
    queue.push({ delta, at });
    this.#pending.set(platformId, queue);
    this.#arm();
  }

  /**
   * Контур отказал по бюджету (402). Пишем сразу и вместе со всем, что
   * накопилось: это факт, а не оценка, и он переживает перезапуск.
   *
   * `refusal` — чей лимит назван в теле (по манифесту драйвера). Прежние
   * scope и уровень не наследуются: новый отказ без названия, записанный
   * поверх старого с названием, выдавал бы старое за новое.
   */
  markExhausted(platformId: string, at = this.#now(), refusal?: BudgetRefusal): void {
    try {
      const record = { ...this.#read(platformId) };
      delete record.exhaustedScope;
      delete record.exhaustedLevel;
      this.#write({
        ...record,
        exhaustedAt: at.toISOString(),
        ...(refusal ? { exhaustedScope: refusal.scope } : {}),
        ...(refusal?.level ? { exhaustedLevel: refusal.level } : {}),
      });
    } catch (error) {
      // Учёт не отвечает за ответ клиенту: отказ 402 контура обязан доехать до
      // CLI, даже если записать его не удалось.
      process.stderr.write(
        `отказ по бюджету у контура ${platformId} не записан (${(error as Error).message})\n`,
      );
    }
    this.flush();
  }

  /** Сбросить накопленное на диск. Пусто — файл не трогаем вовсе. */
  flush(): void {
    this.#disarm();
    if (this.#pending.size === 0) return;

    const pending = this.#pending;
    this.#pending = new Map();

    for (const [platformId, queue] of pending) {
      // Не записалось — очередь возвращается на место и уедет со следующей
      // пачкой. Очищать её ДО удачной записи значило бы терять расход на
      // первой же занятой антивирусом секунде.
      if (!this.#flushOne(platformId, queue)) this.#restore(platformId, queue);
    }
  }

  /** Остановка шлюза: хвост учёта дописывается, таймер снимается. */
  stop(): void {
    this.flush();
    this.#disarm();
  }

  /**
   * Одна пачка одного контура — и ничто из неё не выходит наружу исключением.
   *
   * Колбэк таймера ловить некому: любой отказ отсюда — не записался `state.json`
   * (на Windows переименование отбивает антивирус или индексатор), не прочлись
   * настройки, не сошлась цена — раньше уронил бы ВЕСЬ процесс панели, унося и
   * чат, и всё остальное. Учёт не имеет права ронять панель.
   *
   * Контур, которого в настройках уже нет, расход НЕ воскрешает: пачка живёт
   * несколько секунд, и удаление вполне успевает случиться внутри неё — запись
   * вернулась бы на диск после того, как её оттуда убрали, а идентификатор
   * человек вправе занять заново (переименование выглядит именно так), и новый
   * контур открылся бы с чужим расходом на карточке. Проверка стоит здесь, а не
   * в маршруте удаления, потому что дверей у списка контуров две:
   * `DELETE /api/platforms/:id` и общий `PATCH /api/settings`.
   */
  #flushOne(platformId: string, queue: Pending[]): boolean {
    try {
      const known = readPlatforms(this.#store).some((platform) => platform.id === platformId);
      if (!known) return true;
      // Цена, опубликованная каталогом ЭТОГО контура (DRV-06): у двух контуров
      // одна и та же модель стоит по-разному, и чужой каталог сюда не подмешан.
      const health = this.#store.getPlatformHealth()[platformId];
      const lookup = { ...this.#lookup(), declared: declaredPricing(health?.models ?? []) };
      let record = this.#read(platformId);
      for (const item of queue) record = addSpend(record, item.delta, item.at, lookup);
      return this.#write(record);
    } catch (error) {
      process.stderr.write(
        `расход контура ${platformId} не посчитан (${(error as Error).message}); ` +
          `попробуем со следующей пачкой\n`,
      );
      return false;
    }
  }

  /** Единственная запись на диск, и она тоже огорожена — см. `#flushOne`. */
  #write(record: PlatformSpendRecord): boolean {
    try {
      this.#store.savePlatformSpend(record);
      return true;
    } catch (error) {
      process.stderr.write(
        `расход контура ${record.platformId} не записан (${(error as Error).message}); ` +
          `попробуем со следующей пачкой\n`,
      );
      return false;
    }
  }

  /** Вернуть неудавшуюся очередь вперёд того, что накопилось после неё. */
  #restore(platformId: string, queue: Pending[]): void {
    const later = this.#pending.get(platformId) ?? [];
    const merged = [...queue, ...later];
    if (merged.length > MAX_PENDING) {
      const dropped = merged.length - MAX_PENDING;
      merged.splice(0, dropped);
      process.stderr.write(
        `расход контура ${platformId}: диск не принимает запись, ` +
          `${dropped} ответов учёта отброшено\n`,
      );
    }
    this.#pending.set(platformId, merged);
    // Немедленный режим (`flushMs: 0`) здесь не перезапускаем: сброс, который
    // только что не удался, ушёл бы в бесконечную рекурсию.
    if (this.#flushMs > 0) this.#arm();
  }

  #read(platformId: string): PlatformSpendRecord {
    return this.#store.getPlatformSpend()[platformId] ?? emptySpend(platformId);
  }

  #arm(): void {
    // Ноль означает «без задержки»: так учёт проверяется прогоном, не подгадывая
    // ожидание к таймеру.
    if (this.#flushMs <= 0) {
      this.flush();
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, this.#flushMs);
    // Таймер учёта не имеет права держать процесс живым: панель, которую
    // попросили закрыться, закрывается.
    this.#timer.unref?.();
  }

  #disarm(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
