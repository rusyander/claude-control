import type { ForgePort } from '@agentdeck/contracts/core/forge';
import type { FastifyInstance } from 'fastify';
import type { AdapterRegistry } from '../../adapters/index.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import type { ActionFactReaders } from '../../conductor/reconcile.ts';
import type { RunEconomy } from '../../conductor/run/run.types.ts';
import type { WindowBook } from '../../economy/window/index.ts';
import type { CoreClock } from '../../platform/clock.ts';
import type { CoreHomeLayout } from '../../platform/core-home.ts';
import type { OpenFilesLimit } from '../../platform/limits.ts';
import type { Fact, NotApplicable } from '../../platform/os-kind.ts';
import type { ProcessIdentity } from '../../platform/process-identity.ts';
import type { SessionTokens } from '../../policy/session-tokens/session-tokens.ts';
import type { RouteRegistry } from '../../routes/registry.ts';
import type { LoopOptions } from '../conductor-wiring/index.ts';
import type { CoreRouteConfig } from '../core-routes.ts';
import type { BaseStart } from '../economy-wiring/base-start.ts';
import type { ObserverOptions } from '../observer-wiring/observer-wiring.types.ts';
import type { LoginPathReader, ResourceReaders, SessionRoad } from '../session-road.ts';
import type { SessionRuntime } from '../session-runtime.ts';

export interface BootedCore {
  layout: CoreHomeLayout;
  port: number;
  url: string;
  bootId: string;
  registry: TaskRegistry;
  app: FastifyInstance;
  clock: CoreClock;
  /** Чеканка и проверка токенов сессий — для запускателя сессий (03). */
  sessionTokens: SessionTokens;
  /** Маршруты ядра; чистая остановка освобождает всё, что они держат. */
  routes: RouteRegistry;
  /** Переходники CLI ядра (по id решения compat). */
  adapters: AdapterRegistry;
  /** Живые сессии: запущенная сессия прикрепляется сюда — её вопросы о праве решает ядро. */
  sessions: SessionRuntime;
  /**
   * ОДНА дорога сессии ядра (03 §Launcher): совместимость → окружение → токен → хук + оверлей →
   * запуск → прикрепление → поиск ресурсов на остановке → снятие в конце задачи.
   */
  road: SessionRoad;
  /** Книга окон ядра (G7) — одна: её пишет кран потока, читают судьи, проверки и `/v1/health`. */
  windows: WindowBook;
  /** Экономика исполнителя (этап 5) — та, что каждый `runTask` ядра получает в `RunDeps`. */
  economy: RunEconomy;
  /** Замер базы на старте сеанса (G9) — тот, что дирижёр зовёт после `started`; `stop` ядра его снимает. */
  measureBase: BaseStart;
  /** Задачи, которые сейчас ведёт исполнитель ядра (`runTask`). */
  running(): string[];
  stop(): Promise<void>;
}

export interface BootOptions {
  home?: string;
  build?: string;
  log?: (line: string) => void;
  /** Личность своего процесса; по умолчанию — таблица ОС. Шов для теста отказа загрузки. */
  identity?: (pid: number) => Promise<Fact<ProcessIdentity>>;
  /**
   * Реестр маршрутов целиком (тест одного маршрута); по умолчанию — `buildCoreRoutes`: вход CLI
   * на каждый переходник + заглушки и своя модель из `routeConfig`.
   */
  routes?: RouteRegistry;
  /** Раздел `routes` настройки; по умолчанию — из `config.json` дома ядра (нет файла — пусто). */
  routeConfig?: CoreRouteConfig;
  /**
   * Каталог данных панели (только чтение): профили маршрутов `api-key`/`gateway` и наличие ключей.
   * Нет — `panelAppDataDir()`; `null` — без панели.
   */
  panelAppData?: string | null;
  /** Реестр переходников; по умолчанию — все переходники ядра с их настройками по умолчанию. */
  adapters?: AdapterRegistry;
  /** Сколько вопрос о праве ждёт запроса инструмента в потоке сессии (мс). */
  permitSettleMs?: number;
  /** Читатели фактов сверки; по умолчанию — `actionReaders()` (шов для теста сверки). */
  readers?: ActionFactReaders;
  /** Шаг повторной сверки нерешённого (мс); по умолчанию `RECONCILE_EVERY_MS`. */
  reconcileEveryMs?: number;
  /**
   * PATH оболочки входа для окружения CLI (P104); по умолчанию — настоящее чтение
   * (`platform/shell-path`), один раз на загрузку. Шов для теста дороги сессии.
   */
  loginPath?: LoginPathReader;
  /** Читатели ресурсов сессии (порты, рабочие копии, контейнеры); шов для теста. */
  resourceReaders?: ResourceReaders;
  /**
   * Исполнитель задач (`runTask` на каждую запущенную задачу); по умолчанию включён с пином из
   * окружения ядра. `false` — задачи ведёт вызывающий (сквозной прогон стенда).
   */
  loop?: LoopOptions | false;
  /**
   * Шов теста опроса форжа (05:77): порт форжа вместо настроек панели и шаг таймера. Только из
   * кода теста — ни из окружения, ни из конфига; включение опроса всё равно — `forgePoll` конфига.
   */
  forgePoll?: { forgeFor?: (url: string) => ForgePort; intervalMs?: number };
  /**
   * Подстройки наблюдателя (этап 8) — только из кода теста (F14: раздела настроек нет): порог
   * тишины, проба жизни, часы.
   */
  observer?: ObserverOptions;
  /** Чтение мягкого предела открытых файлов (09 limits); нет — настоящее чтение этой ОС. */
  openFiles?: () => Promise<Fact<OpenFilesLimit> | NotApplicable>;
}

export type Note = (event: string, data: Record<string, unknown>) => void;
