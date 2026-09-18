import type { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from './ca-fetch.ts';
import { checkPlatform } from './check.ts';
import { readPlatforms, readToken } from './store.ts';

/**
 * Перепроверка контура САМОЙ панелью (A-2).
 *
 * Чего не хватало. Единственным поводом сходить к контуру была кнопка
 * «Обновить», и с этого момента каталог моделей, объявленные цены и валидность
 * ключа застывали: расход считался по прайсу пробы, снятой неизвестно когда, а
 * токены моделей, которых в том каталоге уже нет, уходили в `unpricedTokens` —
 * полоса бюджета стояла на нуле по ключу, который тратят. Режим «Картинка»
 * отвечал `no-model` по тому же устаревшему каталогу.
 *
 * ЧЕТЫРЕ ОГРАНИЧЕНИЯ, и каждое стоит на своей причине:
 *
 * 1. НИКОГДА НА ПУТИ ЗАПРОСА. Проба идёт до 15 с; вшитая в расчёт плана или в
 *    маршрут списка она превратила бы открытие экрана в ожидание чужого
 *    сервера. Здесь только таймер.
 * 2. ТОЛЬКО АКТИВНЫЙ контур, включённый и с ключом. Остальные панель не
 *    использует, и ходить в них — тратить чужой ключ без повода.
 * 3. ИНТЕРВАЛ В НАСТРОЙКАХ (`platformProbeMinutes`, ноль — не ходить вовсе):
 *    проба оставляет след в журнале контура, и как часто панель вправе там
 *    появляться, решает компания. Первая проба — не раньше чем через интервал:
 *    при старте панели по-прежнему не ходит никто.
 * 4. ОТКАЗ, ПАХНУЩИЙ ПРАВАМИ (401/403 на модель), — второй повод, и он спешный:
 *    именно так выглядит отозванный ключ и снятая с ключа модель, а карточка до
 *    следующего интервала говорила бы «проверено, всё хорошо». У него свой пол
 *    ({@link RIGHTS_FLOOR_MS}): шлюз получает такой отказ на КАЖДЫЙ запрос
 *    упавшего CLI, и проба на каждый из них была бы обстрелом чужого журнала.
 */

/** Не чаще этого ходим после отказа, пахнущего правами. */
export const RIGHTS_FLOOR_MS = 10 * 60_000;

/** Как скоро после такого отказа идём — не мгновенно: у CLI бывает очередь. */
export const RIGHTS_DELAY_MS = 5_000;

export interface PlatformWatchDeps {
  store: AppStore;
  appDataDir: string;
  /** Подстановка транспорта для тестов: настоящая проба здесь не нужна. */
  fetchImpl?: PlatformFetch;
  now?: () => number;
  /** Куда сказать о неудаче пробы. Не задан — молчим: это фон, а не ответ. */
  onError?: (error: unknown) => void;
}

export class PlatformWatch {
  readonly #deps: PlatformWatchDeps;
  readonly #now: () => number;
  #timer?: NodeJS.Timeout;
  #rights?: NodeJS.Timeout;
  #lastRightsProbeAt = 0;
  #busy = false;

  constructor(deps: PlatformWatchDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Завести расписание. Интервал читается ОДИН раз, при заводе: менять его
   * человек вправе, и применяется он перезапуском панели — сторожить настройку
   * ради пробы раз в полсуток значило бы держать второй таймер ради удобства,
   * которого никто не просил.
   */
  start(): void {
    this.stop();
    const minutes = this.#deps.store.getSettings().platformProbeMinutes;
    if (minutes <= 0) return;
    this.#timer = setInterval(() => void this.probeNow(), minutes * 60_000);
    // Таймер фона не имеет права держать процесс живым: панель, которую
    // попросили закрыться, закрывается.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#rights) clearTimeout(this.#rights);
    this.#timer = undefined;
    this.#rights = undefined;
  }

  /**
   * Шлюз получил отказ, пахнущий правами. Зовётся с пути запроса — и поэтому
   * НИЧЕГО не ждёт: ставит отложенную пробу и возвращается.
   */
  noteRightsRefusal(platformId: string): void {
    if (platformId !== this.#activeId()) return;
    if (this.#rights) return;
    if (this.#lastRightsProbeAt && this.#now() - this.#lastRightsProbeAt < RIGHTS_FLOOR_MS) return;
    this.#lastRightsProbeAt = this.#now();
    this.#rights = setTimeout(() => {
      this.#rights = undefined;
      void this.probeNow();
    }, RIGHTS_DELAY_MS);
    this.#rights.unref?.();
  }

  /**
   * Сходить прямо сейчас, если есть куда. Не бросает: фоновая проба — это
   * запись на диск, а не ответ кому-то, и её отказ не повод ронять таймер.
   */
  async probeNow(): Promise<void> {
    // Проба идёт до 15 с, а интервал человек вправе поставить и в минуту:
    // вторая проба поверх первой удвоила бы след в чужом журнале.
    if (this.#busy) return;
    const id = this.#activeId();
    if (!id) return;
    this.#busy = true;
    try {
      await checkPlatform(this.#deps.store, this.#deps.appDataDir, id, this.#deps.fetchImpl, {
        background: true,
      });
    } catch (error) {
      this.#deps.onError?.(error);
    } finally {
      this.#busy = false;
    }
  }

  /** Активный, включённый и с ключом. Иначе ходить не к кому и незачем. */
  #activeId(): string | undefined {
    const settings = this.#deps.store.getSettings();
    const active = readPlatforms(this.#deps.store).find(
      (platform) => platform.id === settings.activePlatformId && platform.enabled,
    );
    if (!active) return undefined;
    return readToken(this.#deps.appDataDir, active.id) ? active.id : undefined;
  }
}
