import type { PlatformGatewayEvent, PlatformUsageRecord } from '@agentdeck/contracts';

/**
 * Учёт: сколько прошло через шлюз и что при этом случилось.
 *
 * Считается В ТОКЕНАХ. Денег здесь нет: раньше рядом лежала «та же формула, что
 * у контура» — всего токенов × 0.00001 $ (справочник §9, константа
 * `tokenCostUSD`), и она БОЛЬШЕ НЕ ВЕРНА. Контур тарифицирует по ценам реестра
 * моделей, prompt и completion раздельно, а модель без цены не списывает вовсе
 * (так считает сам контур); самой константы в его
 * исходниках не осталось. Деньги у панели одни — оценка по нашему прайсу
 * (`spend.ts`), и она подписана как оценка.
 *
 * Что здесь НЕ хранится и храниться не будет: тела запросов и ответов, текст,
 * на котором сработали проверки контура, и ключ в любом виде. След запроса —
 * это путь, код, стадии и НАЗВАНИЯ нарушенного, и ничего сверх.
 *
 * Живёт в памяти процесса: перезапуск панели обнуляет счётчики. Постоянный учёт
 * с разбором по дням — задача Т8, и заводить под него половину хранилища
 * заранее значило бы угадывать её форму.
 */

/** Сколько следов держим. Больше человеку не нужно, а память не резиновая. */
const MAX_EVENTS = 50;

export interface UsageDelta {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class GatewayJournal {
  #usage = new Map<string, PlatformUsageRecord>();
  #events: PlatformGatewayEvent[] = [];
  /** Счётчики считаются отдельно от следов: следов хранится последние 50. */
  #requests = 0;
  #failures = 0;

  /** Прибавить расход одного ответа. Пустой расход тоже считается запросом. */
  addUsage(platformId: string, delta: UsageDelta, at = new Date()): void {
    const current = this.#usage.get(platformId) ?? {
      platformId,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      at: at.toISOString(),
    };

    this.#usage.set(platformId, {
      platformId,
      requests: current.requests + 1,
      promptTokens: current.promptTokens + delta.promptTokens,
      completionTokens: current.completionTokens + delta.completionTokens,
      totalTokens: current.totalTokens + delta.totalTokens,
      at: at.toISOString(),
    });
  }

  /** Записать след запроса. Новые сверху — так его и читают. */
  addEvent(event: PlatformGatewayEvent): void {
    this.#requests += 1;
    if (event.status >= 400) this.#failures += 1;
    this.#events.unshift(event);
    if (this.#events.length > MAX_EVENTS) this.#events.length = MAX_EVENTS;
  }

  /** Сколько запросов прошло всего и сколько кончились отказом. */
  totals(): { requests: number; failures: number } {
    return { requests: this.#requests, failures: this.#failures };
  }

  usage(): PlatformUsageRecord[] {
    return [...this.#usage.values()];
  }

  events(): PlatformGatewayEvent[] {
    return [...this.#events];
  }

  clear(): void {
    this.#usage.clear();
    this.#events = [];
    this.#requests = 0;
    this.#failures = 0;
  }
}
