import type { FastifyInstance } from 'fastify';
import type { ConfigPort } from '../api/config.types.ts';
import { buildApi, type ApiDeps, type HealthInfo } from '../api/server.ts';
import type { SessionStatePort } from '../api/session-state.types.ts';
import { registerSessionTools } from '../api/session-tools.ts';
import type {
  ClearExhaustedPort,
  PublisherCommandPort,
  ReconcileRecheckPort,
  SetRoutePorts,
} from '../conductor/commands/commands.types.ts';
import { ladderRank } from '../conductor/commands/set-model.ts';
import type { SplitEnv } from '../conductor/estimate/index.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { TierLadder } from '../economy/tier.types.ts';
import type { WindowBook } from '../economy/window/index.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { peerPid } from '../platform/peer-pid.ts';
import { osProcessTable } from '../platform/process-table.ts';
import { createNonceStore } from '../policy/authority/nonce.ts';
import type { SessionTokens } from '../policy/session-tokens/session-tokens.ts';
import { devicesPortOf, loadSigningDevices, machineIdOf, type DevicesNote } from './devices.ts';
import { humanPolicyOf } from './human-policy.ts';
import { processPin } from './conductor-wiring/session-start.ts';
import { createMcpOffersPort } from './mcp-offers.ts';
import type { SessionRuntime } from './session-runtime.ts';
import type { TrustedHops } from './trusted-hops.ts';
import { createSessionPeerCheck, sessionRootsOf } from './session-peers.ts';
import { unitDiffWiring } from './unit-diff-wiring.ts';
import type { VerifierWiring } from './verifier-wiring/index.ts';

/**
 * API ядра в сборе (07 §API): дорога человека и панели (`buildApi`) + дорога модели
 * (`/v1/session/*`). Здесь же — откуда API знает, кто звонит: pid пира из таблицы TCP и дерево
 * сессий из журналов задач по таблице процессов (ревью F-15: раньше «никто не из сессии»).
 */

export interface BootApiDeps {
  registry: TaskRegistry;
  layout: CoreHomeLayout;
  coreToken: string;
  sessionTokens: SessionTokens;
  sessions: SessionRuntime;
  health: HealthInfo;
  /** Журнал ядра: дрейф списка устройств подписи (`devices.drift`) называется здесь. */
  note: DevicesNote;
  /** Книга окон ядра (G7): одна на процесс, её пишет проводка экономики, health читает. */
  windows: WindowBook;
  /**
   * Проверки в сборе — одна обвязка на ядро, собирает её `boot.ts`: тот же реестр стендов нужен
   * дороге сессии (снятие стенда в конце задачи) и дирижёру этапа 4.
   */
  verifier: VerifierWiring;
  /**
   * Среда деления дирижёра. API поднимается раньше дирижёра (мосту сессии нужен порт ядра),
   * поэтому здесь порт: `boot.ts` заполняет его после `startConductor` и очищает на остановке.
   * `undefined` — оценка и запуск отказывают «не подключено», а не идут без предпроверки.
   */
  split: () => SplitEnv | undefined;
  /** Секреты окружения сеанса (P61, `bootEconomy.known`): тело `unit_diff` маскирует и их. */
  known?: (taskId: string, sessionId: string) => readonly string[];
  /**
   * Реестр маршрутов загрузки для команды `set-route`; без него команда отказывает
   * `routes-unwired` — так было на собранном ядре до W2b (команда не применялась никогда).
   */
  routes?: () => SetRoutePorts | undefined;
  /** Клиент хоста звеньев для команды `clear-exhausted`; без него — отказ `hop-unwired`. */
  hops?: () => ClearExhaustedPort | undefined;
  /** Таймер сверки загрузки для ответа «повторить сверку»; нет — сверит следующая загрузка. */
  reconcile?: () => ReconcileRecheckPort | undefined;
  /** Публикатор дирижёра для `publish-now` / `clean-remote`; без него — отказ `publisher-unwired`. */
  publisher?: () => PublisherCommandPort | undefined;
  /** Настройка ядра для `/v1/config` (этап 7); нет — 501 «не подключена». */
  config?: () => ConfigPort | undefined;
  /** Документ `agentdeck state` для `/v1/session/state` (этап 7); нет — 501. */
  sessionState?: SessionStatePort;
  /**
   * Лестницы переходников загрузки (`bootEconomy.ladders`): ранг модели для предупреждения
   * `set-model` «ревьюер ниже автора». Нет — предупреждение называет ранг неизвестным.
   */
  ladders?: Readonly<Record<string, TierLadder>>;
  /** Цена маршрута для вида задачи панели (этап 9, `api/task-view.ts`); нет — токены без цены. */
  routePrice?: ApiDeps['routePrice'];
  /** Маршруты этой загрузки для `/v1/routes` панели (этап 9). */
  routeList?: ApiDeps['routes'];
  /** Доверенные звенья пересылки, записанные надзором (P131); нет — звеньев нет. */
  trustedHops?: Pick<TrustedHops, 'pids' | 'view'>;
  /** Реестр переходников загрузки для вида сеанса (этап 10); нет — `…/stream` отвечает 501. */
  adapters?: ApiDeps['adapters'];
  /** Удержание своей модели панелью (этап 10, зона C); нет — `/v1/local/*` отвечает 501. */
  localHold?: ApiDeps['localHold'];
  /** Учёт контуров звена (этап 10, C3b); нет — `/v1/contours*` отвечает 501. */
  contours?: ApiDeps['contours'];
  /** Прокси защиты данных человека (C3c); нет — `/v1/dlp-proxy*` отвечает 501. */
  dlpProxy?: ApiDeps['dlpProxy'];
  /** Лёгкая сессия панели `/v1/ask` (этап 10, F2): дирижёр + книга токенов моста. */
  ask?: ApiDeps['ask'];
  /** Ревью MR по ссылке (этап 10, F8): проводка дирижёра, пока он жив. */
  reviewLink?: ApiDeps['reviewLink'];
}

export function buildCoreApi(deps: BootApiDeps): FastifyInstance {
  const { registry, sessionTokens, verifier } = deps;
  const devicesPort = devicesPortOf(deps.layout, deps.note);
  // Номер машины создаётся загрузкой (как прежде), читается — на каждой подписи (ниже).
  machineIdOf(deps.layout);
  // Пин — тот же, что получают сеансы задач (`processPin`): экран видит серверы, которые увидит CLI.
  const offers = deps.adapters ? createMcpOffersPort(deps.adapters, processPin()) : undefined;
  const app = buildApi({
    registry,
    env: {
      layout: deps.layout,
      split: () => deps.split(),
      ...(deps.routes ? { routes: deps.routes } : {}),
      ...(deps.hops ? { hops: deps.hops } : {}),
      ...(deps.reconcile ? { reconcile: deps.reconcile } : {}),
      ...(deps.publisher ? { publisher: deps.publisher } : {}),
      ...(deps.ladders ? { modelRank: ladderRank(deps.ladders) } : {}),
    },
    tokens: {
      core: deps.coreToken,
      isSessionToken: (t) => sessionTokens.verify(t) !== undefined,
    },
    nonces: createNonceStore(),
    peer: {
      peerPid: (query) => peerPid(query),
      // Корни — хост и CLI каждой сессии из журналов; таблица не прочитана — `unknown`
      // (строгая команда тогда только с подписью), никогда «не из сессии».
      isSessionDescendant: createSessionPeerCheck({
        roots: () => sessionRootsOf(registry),
        table: osProcessTable(),
      }),
      // Звенья пересылки пишет только надзор (P131): пусто — пересланная команда без доверия.
      trustedHopPids: deps.trustedHops?.pids ?? new Set(),
    },
    signature: {
      // Читается на каждой подписи, а не при загрузке: перенос устройств меняет номер на номер
      // машины панели (этап 10, Q5), и следующая же подпись телефона судится уже им.
      get machineId() {
        return machineIdOf(deps.layout);
      },
      devices: () => loadSigningDevices(deps.layout, deps.note),
      now: Date.now,
    },
    health: deps.health,
    windows: deps.windows,
    now: Date.now,
    ...(deps.config ? { config: deps.config } : {}),
    ...(deps.routePrice ? { routePrice: deps.routePrice } : {}),
    ...(deps.routeList ? { routes: deps.routeList } : {}),
    ...(deps.trustedHops ? { trustedHops: deps.trustedHops.view } : {}),
    ...(deps.adapters ? { adapters: deps.adapters } : {}),
    // Предложения MCP читаются на каждом запросе: правка конфига CLI видна без перезапуска ядра.
    ...(offers ? { mcpOffers: () => offers } : {}),
    ...(deps.localHold ? { localHold: deps.localHold } : {}),
    ...(deps.contours ? { contours: deps.contours } : {}),
    ...(deps.dlpProxy ? { dlpProxy: deps.dlpProxy } : {}),
    ...(deps.ask ? { ask: deps.ask } : {}),
    ...(deps.reviewLink ? { reviewLink: deps.reviewLink } : {}),
    // Ключи телефона в устройства ядра (G9): тот же дом и журнал, что у чтения списка выше.
    devices: () => devicesPort,
  });
  // Дорога модели (`/v1/session/*`, W2-C): мосты MCP сессий ходят сюда с токеном сессии.
  registerSessionTools(app, {
    registry,
    tokens: sessionTokens,
    tools: {
      ...verifier.verify,
      // Инструмент модели `check` — единый вход проверок (зона C), не ответ «проверки нет».
      check: verifier.queue.check,
      unitDiff: unitDiffWiring(deps.known),
      humanPolicy: humanPolicyOf(deps.layout),
    },
    // Кодек права даёт переходник прикреплённой сессии; сессии нет в рантайме (не прикреплена,
    // поток кончился) — вопрос о праве отказывается (503, fail-closed), а не разрешается.
    permitDeps: (task, binding) => deps.sessions.permitDeps(task, binding),
    ...(deps.sessionState ? { state: deps.sessionState } : {}),
  });
  // Захват прогонов проверок (`/v1/session/capture*`): прокладка и обёртки PATH спрашивают тут.
  verifier.capture.register(app, sessionTokens);
  return app;
}
