import { createServer, type Server } from 'node:http';
import type { PlatformGatewayRoute, PlatformGatewayStatus } from '@agentdeck/contracts';
import type { CompromiseId } from '@agentdeck/contracts/compromises';
import type { AppStore } from '../../../lib/app-store.ts';
import type { PlatformFetch } from '../ca-fetch.ts';
import { readPlatforms, readToken } from '../store.ts';
import { reconcileManagedProfiles } from '../apply/profile.ts';
import { toolShimReport } from '../tool-shim-report.ts';
import { violationReport } from '../violations.ts';
import type { PricingLookup } from '../../analytics/pricing.ts';
import { driverOf } from '../drivers/index.ts';
import { nativeMessagesPath } from './anthropic-native.ts';
import { GATEWAY_ROUTES, handleGatewayRequest, type ToolCallGate } from './pipeline.ts';
import { SpendFlusher, type BudgetCrossingNotice } from './spend-flush.ts';
import { summarizedReport } from './summarized-ledger.ts';
import { GatewayJournal } from './usage.ts';
import { localizeText, serverText } from '../../../lib/server-texts.ts';

/**
 * Слушатель шлюза: один порт на все контуры, различаемые первым сегментом
 * адреса (`http://127.0.0.1:5179/<контур>/v1/...`).
 *
 * Три вещи заданы жёстко и в настройки не выносятся:
 *
 * 1. ТОЛЬКО 127.0.0.1. Шлюз ходит наверх по корпоративному ключу и видит тела
 *    запросов; доступ к нему из сети означал бы, что чужой может и читать чужие
 *    промпты, и тратить чужой бюджет.
 * 2. Занятый порт — не падение. Панель берёт соседний и НАЗЫВАЕТ его: адрес для
 *    CLI человек всё равно копирует отсюда, а упавший при старте слушатель
 *    выглядел бы как «шлюз не работает вообще».
 * 3. Всё, кроме трёх известных маршрутов, — 404 с внятным телом. Шлюз не
 *    притворяется полным сервером OpenAI: молчаливое «200 на всё» дало бы CLI
 *    уверенность, которой он не заслужил.
 */

/** Сколько соседних портов пробуем, прежде чем признать поражение. */
const PORT_ATTEMPTS = 10;

/**
 * Сколько ждём живые соединения на остановке. `server.close()` сам по себе
 * ждёт КАЖДОЕ: один поток ответа держит перезапуск шлюза столько, сколько
 * отвечает контур (у ingress потолок — час), и человек, нажавший «перезапустить»,
 * видит зависшую панель. Простаивающие соединения закрываются сразу, живые —
 * через эту паузу.
 */
const STOP_GRACE_MS = 1_000;

/**
 * Подписи, которые несёт шлюз. Список отдаёт СЕРВЕР: снятая подпись обязана
 * погаснуть на экране сама, без правки разметки.
 */
const GATEWAY_COMPROMISES: CompromiseId[] = [
  'dialect-bridge',
  'vendor-sse-frames',
  'status-451-bridge',
  // compromise: gateway-required — CLI ходят в панель, а не в контур: панель выключена — модели у них нет
  'gateway-required',
  'nonstream-120s',
  'context-managed',
  // Цена прослойки инструментов: правила и схемы едут в КАЖДОМ ходе, кэша
  // промпта у платформы нет. Значка на экране у этой подписи нет и быть не
  // может — платит за неё шлюз, а не элемент интерфейса.
  'shim-no-cache',
];

export interface GatewayRuntime {
  store: AppStore;
  appDataDir: string;
  /** Порт из настроек. Занят — возьмём соседний и скажем, какой. */
  port: number;
  /** Подстановка транспорта для тестов. */
  fetchImpl?: PlatformFetch;
  /**
   * Цены для оценки денег (Т8). Не задано — расход считается только во
   * внутренней единице контура, и панель об этом говорит, а не показывает ноль
   * долларов.
   */
  pricing?: () => PricingLookup;
  /** Раз во сколько учёт уезжает на диск. Ноль — сразу, так его и проверяют. */
  spendFlushMs?: number;
  /** Подстановка часов для тестов: потолок ответа в минуты тест не ждёт. */
  now?: () => Date;
}

export class PlatformGateway {
  #server?: Server;
  #runtime?: GatewayRuntime;
  #journal = new GatewayJournal();
  #spend?: SpendFlusher;
  #port = 0;
  #error?: string;
  /**
   * Подъёмы и остановки идут строго по очереди. Зовут их с разных мест —
   * активация, «Поднять шлюз» на карточке, перезапуск по настройке, — и без
   * очереди остановка посреди подъёма возвращалась раньше, чем подъём назначал
   * сервер: шлюз оживал после «погасить», а два подъёма разом теряли один
   * слушатель, продолжавший держать порт.
   */
  #queue: Promise<void> = Promise.resolve();
  /**
   * Куда сказать о перейденном пороге бюджета. Ставится снаружи, как нотификатор
   * реестра прогонов, и ПЕРЕЖИВАЕТ перезапуск шлюза: подписка — свойство панели,
   * а не конкретного слушателя, и терять её на смене порта было бы нечестно.
   */
  #notifyBudget?: (notice: BudgetCrossingNotice) => void;

  setBudgetNotifier(notify: (notice: BudgetCrossingNotice) => void): void {
    this.#notifyBudget = notify;
  }

  /**
   * Кому сказать, что контур отказал по правам (401/403) — A-2. Той же
   * расстановкой и по той же причине: фоновая перепроверка живёт в домене, а
   * слушатель знает только про запросы.
   */
  #onRightsRefusal?: (platformId: string) => void;

  setRightsRefusalNotifier(notify: (platformId: string) => void): void {
    this.#onRightsRefusal = notify;
  }

  /**
   * Ворота вызовов инструментов по метке прогона (П4.1). Ставятся снаружи и той
   * же расстановкой, и по той же причине: реестр открытых прогонов — свойство
   * панели, а не слушателя, и терять его на смене порта значило бы снять хуки с
   * прогонов, которые в этот момент идут.
   */
  #toolGate?: (runTag: string) => ToolCallGate | undefined;

  setToolGate(resolve: (runTag: string) => ToolCallGate | undefined): void {
    this.#toolGate = resolve;
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Дописать накопленный расход на диск прямо сейчас.
   *
   * Публично ради двух вещей: остановки панели и прогонов, которые иначе
   * подгадывали бы ожидание к таймеру сброса.
   */
  flushSpend(): void {
    this.#spend?.flush();
  }

  get running(): boolean {
    return Boolean(this.#server?.listening);
  }

  /**
   * Вызовы инструментов агента (прослойкой и полем) в запросах с момента
   * `sinceMs` — чату чужого CLI, у которого своего транскрипта вызовов нет
   * (развилка 5). `undefined` — запросов за это время не было.
   */
  toolCallsSince(sinceMs: number): number | undefined {
    let requests = 0;
    let calls = 0;
    for (const event of this.#journal.events()) {
      if (Date.parse(event.at) < sinceMs) continue;
      requests += 1;
      calls += event.toolCalls + (event.nativeCalls ?? 0);
    }
    return requests > 0 ? calls : undefined;
  }

  status(): PlatformGatewayStatus {
    const totals = this.#journal.totals();
    return {
      running: this.running,
      address: this.running ? `http://127.0.0.1:${this.#port}` : '',
      port: this.#port,
      requestedPort: this.#runtime?.port ?? 0,
      error: this.#error,
      requests: totals.requests,
      failures: totals.failures,
      routes: this.#routes(),
      usage: this.#journal.usage(),
      events: this.#journal.events(),
      // Сводка проверок — только по ВКЛЮЧЁННЫМ контурам: след выключенного,
      // оставшийся на экране, читается как след того, на который человек
      // смотрит, а выключение обязано возвращать раздел к прежнему виду.
      violations: violationReport(this.#journal.events(), { platformIds: this.#enabledIds() }),
      toolShim: toolShimReport(this.#journal.events(), { platformIds: this.#enabledIds() }),
      // Сжатия — с диска, а не из журнала запросов: карточка и подписи в ленте
      // обязаны пережить перезапуск панели. Шлюз ни разу не поднимали — сводка пуста.
      summarized: this.#runtime
        ? summarizedReport(this.#runtime.appDataDir)
        : { total: 0, recent: [] },
      compromises: this.#compromises(),
    };
  }

  start(runtime: GatewayRuntime): Promise<void> {
    return this.#enqueue(() => this.#startNow(runtime));
  }

  stop(): Promise<void> {
    return this.#enqueue(() => this.#stopNow());
  }

  async #startNow(runtime: GatewayRuntime): Promise<void> {
    await this.#stopNow();
    this.#error = undefined;
    this.#runtime = runtime;
    this.#spend = new SpendFlusher({
      store: runtime.store,
      ...(runtime.pricing ? { lookup: runtime.pricing } : {}),
      ...(runtime.spendFlushMs === undefined ? {} : { flushMs: runtime.spendFlushMs }),
      // Через замыкание, а не значением: подписку ставят один раз при сборке
      // приложения, а слушатель пересоздаётся на каждой смене порта.
      notifyBudget: (notice) => this.#notifyBudget?.(notice),
    });

    const server = createServer((request, response) => {
      void handleGatewayRequest(request, response, {
        store: runtime.store,
        appDataDir: runtime.appDataDir,
        journal: this.#journal,
        spend: this.#spend,
        onRightsRefusal: (platformId) => this.#onRightsRefusal?.(platformId),
        toolGate: (runTag) => this.#toolGate?.(runTag),
        fetchImpl: runtime.fetchImpl,
        ...(runtime.now ? { now: runtime.now } : {}),
      }).catch(() => {
        // Беда ОДНОГО запроса не делает слушатель сломанным: `#error` — это
        // «шлюз не поднялся», и записанная сюда чужая ошибка красила бы
        // работающий шлюз в отказ до следующего перезапуска. Ни одного тела и
        // ни одного заголовка чужой ошибки наружу: в них приезжает
        // `Authorization` целиком.
        if (response.headersSent) {
          response.end();
          return;
        }
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: {
              message: localizeText(
                serverText('gateway-failed'),
                runtime.store.getSettings().language,
              ),
            },
          }),
        );
      });
    });

    try {
      this.#port = await listen(server, runtime.port);
      this.#server = server;
      // Доставшийся порт публикуется в состоянии панели: снаружи (сторож
      // стенда) его больше неоткуда узнать, а задуманный совпадает с портом
      // прокси защиты данных и потому обманывает.
      runtime.store.setPlatformGatewayPort(this.#port);
      // ...и тут же пересобираются управляемые профили. Профиль — ХРАНИМАЯ
      // запись с адресом внутри: без этой строки панель, поднявшаяся на
      // соседнем порту, продолжала бы слать промпты своего ассистента на
      // задуманный — то есть тому процессу, который порт и занял.
      reconcileManagedProfiles(runtime.store);
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.#port = 0;
      runtime.store.setPlatformGatewayPort(0);
      server.close();
      throw error;
    }
  }

  async #stopNow(): Promise<void> {
    const server = this.#server;
    const store = this.#runtime?.store;
    // Хвост учёта дописывается ДО всего остального: перезапуск шлюза — обычное
    // дело (сменили порт, переключили тумблер), и терять на нём последние
    // секунды расхода незачем.
    this.#spend?.stop();
    this.#spend = undefined;
    this.#server = undefined;
    this.#port = 0;
    store?.setPlatformGatewayPort(0);
    if (!server) return;

    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // `close` ждёт КАЖДОЕ соединение до конца — а на шлюзе это поток ответа и
    // keep-alive сокеты CLI, то есть минуты. Простаивающие рвём сразу, живым
    // даём короткую отсрочку и рвём тоже: остановка шлюза не должна зависеть
    // от того, сколько ещё намерен говорить контур.
    server.closeIdleConnections();
    const grace = setTimeout(() => server.closeAllConnections(), STOP_GRACE_MS);
    try {
      await closed;
    } finally {
      clearTimeout(grace);
    }
  }

  /** Адреса, которые человек копирует в CLI, — по одному на контур. */
  /** Контуры, которые шлюз обслуживает прямо сейчас. Без рантайма — ни одного. */
  /**
   * Мост диалектов подписан, пока хоть одному включённому контуру он нужен:
   * у платформы, идущей на родную ручку Anthropic (DRV-07), моста нет, и
   * подпись о нём была бы неправдой. Ни одного включённого — подпись остаётся: так шлюз
   * говорит, чем станет, а не молчит.
   */
  #compromises(): CompromiseId[] {
    const runtime = this.#runtime;
    const enabled = runtime
      ? readPlatforms(runtime.store).filter((platform) => platform.enabled)
      : [];
    const bridged =
      enabled.length === 0 ||
      enabled.some((platform) => !nativeMessagesPath(platform, driverOf(platform)));
    return bridged
      ? GATEWAY_COMPROMISES
      : GATEWAY_COMPROMISES.filter((id) => id !== 'dialect-bridge');
  }

  #enabledIds(): string[] {
    const runtime = this.#runtime;
    if (!runtime) return [];
    return readPlatforms(runtime.store)
      .filter((platform) => platform.enabled)
      .map((platform) => platform.id);
  }

  #routes(): PlatformGatewayRoute[] {
    const runtime = this.#runtime;
    if (!runtime || !this.running) return [];
    return readPlatforms(runtime.store).map((platform) => ({
      platformId: platform.id,
      title: platform.title,
      address: `http://127.0.0.1:${this.#port}/${platform.id}/v1`,
      paths: [...GATEWAY_ROUTES],
      ready: platform.enabled && Boolean(readToken(runtime.appDataDir, platform.id)),
    }));
  }
}

/**
 * Занять порт, а при занятом — соседний. Возвращает порт, который достался
 * НА САМОМ ДЕЛЕ: он и уезжает в адрес для CLI.
 */
async function listen(server: Server, port: number): Promise<number> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const candidate = port + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        // Только петлевой интерфейс — см. пункт 1 в шапке файла.
        server.listen(candidate, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      // Порт спрашиваем у сокета, а не берём задуманный: с нулём («любой
      // свободный») задуманный не равен доставшемуся, а в адрес для CLI уезжает
      // именно доставшийся.
      const address = server.address();
      return typeof address === 'object' && address ? address.port : candidate;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isPortBusy(lastError)) throw lastError;
    }
  }

  throw new Error(
    serverText('gateway-ports-busy', {
      from: port,
      to: port + PORT_ATTEMPTS - 1,
      reason: lastError?.message ?? serverText('gateway-ports-busy-unknown'),
    }),
  );
}

function isPortBusy(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}
