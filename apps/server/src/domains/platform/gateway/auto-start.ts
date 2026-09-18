/**
 * Подъём СВОЕГО слушателя шлюза, когда тумблер уже включён, а слушателя нет.
 *
 * Зачем отдельным объектом. Погашенный слушатель запирал режим «Картинка»
 * причиной `gateway-off` и посылал человека на страницу «Платформа» — притом
 * что поднять его панель умеет одним вызовом, тем же, которым пользуется
 * активация контура. Два состояния здесь РАЗНЫЕ, и путать их нельзя:
 *
 *   1. тумблер `platformGateway.enabled` выключен — это выбор человека, и
 *      снимает его он же: замок остаётся, подпись остаётся, панель молчит;
 *   2. тумблер включён, а слушателя нет (порт заняли, панель только поднялась,
 *      прошлый подъём отбился) — поднять обязана панель, а не человек.
 *
 * Тумблер этот объект НЕ ТРОГАЕТ никогда. Включить настройку за человека — это
 * то, что делает активация контура по его же нажатию (`routes/platform-routes.ts
 * → ensureGateway`), и делать то же самое молча, по открытию меню чата, значило
 * бы менять настройку без единого нажатия.
 *
 * ЗАЩЁЛКА ОБЯЗАТЕЛЬНА. Расчёт плана картинки идёт на каждое открытие меню
 * (а телефон ещё и опрашивает его), и подъём без потолка превратил бы
 * занятый порт в бесконечную череду попыток `listen` — по десять сокетов на
 * каждую (`PORT_ATTEMPTS`). Поэтому: одна попытка за раз, пауза между
 * попытками и потолок неудач, после которого панель перестаёт пытаться и
 * НАЗЫВАЕТ настоящую причину отказа слушателя.
 */

/** Сколько раз пытаемся поднять слушатель сами, прежде чем перестать. */
export const AUTO_START_ATTEMPTS = 3;

/** Пауза между попытками: два расчёта плана подряд не считаются двумя поводами. */
export const AUTO_START_COOLDOWN_MS = 60_000;

export interface GatewayAutoStartDeps {
  /** Тумблер настройки. Выключен — не наше дело, и мы не вмешиваемся. */
  enabled: () => boolean;
  /** Слушатель ЖИВОЙ, а не задуманный: порт мог занять чужой процесс. */
  running: () => boolean;
  /** Поднять по сохранённой настройке. Отказ приезжает исключением. */
  start: () => Promise<void>;
  now?: () => number;
}

/** Что из этого узнал план картинки: пробовали ли и чем кончилось. */
export interface GatewayAutoStartState {
  /** Сколько неудач подряд насчитано. */
  failures: number;
  /** Потолок исчерпан — больше не пытаемся до сброса. */
  exhausted: boolean;
  /** Отказ последней попытки словами. Пусто — не пытались или получилось. */
  error?: string;
}

export class GatewayAutoStart {
  readonly #deps: GatewayAutoStartDeps;
  readonly #now: () => number;
  #failures = 0;
  #lastAttemptAt = 0;
  #error?: string;
  #inFlight?: Promise<void>;

  constructor(deps: GatewayAutoStartDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  state(): GatewayAutoStartState {
    return {
      failures: this.#failures,
      exhausted: this.#failures >= AUTO_START_ATTEMPTS,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /**
   * Поднять, если нужно и если можно. Не бросает НИКОГДА: не поднявшийся шлюз —
   * это состояние с названной причиной, а не отказ маршрута, который у человека
   * спрашивали совсем о другом.
   */
  async ensure(): Promise<void> {
    if (this.#deps.running()) {
      // Шлюз жив — прошлые неудачи больше ничего не значат: следующее падение
      // порта обязано получить свои попытки, а не доживать чужой потолок.
      this.reset();
      return;
    }
    if (!this.#deps.enabled()) return;
    if (this.#failures >= AUTO_START_ATTEMPTS) return;
    if (this.#lastAttemptAt && this.#now() - this.#lastAttemptAt < AUTO_START_COOLDOWN_MS) return;
    // Два расчёта плана разом (вкладка и телефон) — одна попытка на двоих:
    // иначе второй подъём отобрал бы порт у первого.
    if (this.#inFlight) return this.#inFlight;

    this.#lastAttemptAt = this.#now();
    const attempt = this.#attempt();
    this.#inFlight = attempt;
    try {
      await attempt;
    } finally {
      this.#inFlight = undefined;
    }
  }

  /**
   * Забыть неудачи. Зовётся, как только слушатель увиден ЖИВЫМ — сам он поднялся
   * или человек нажал «Поднять шлюз», неважно: порт освободился, и держать
   * прошлый потолок значило бы отвечать «больше не пытаемся» тому, кто чинил
   * именно это.
   */
  reset(): void {
    this.#failures = 0;
    this.#lastAttemptAt = 0;
    this.#error = undefined;
  }

  async #attempt(): Promise<void> {
    try {
      await this.#deps.start();
      this.reset();
    } catch (error) {
      this.#failures += 1;
      this.#error = error instanceof Error ? error.message : String(error);
    }
  }
}
