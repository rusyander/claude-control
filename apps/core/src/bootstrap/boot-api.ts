import type { FastifyInstance } from 'fastify';
import { buildApi, type HealthInfo } from '../api/server.ts';
import { registerSessionTools } from '../api/session-tools.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';
import { peerPid } from '../platform/peer-pid.ts';
import { osProcessTable } from '../platform/process-table.ts';
import type { HumanPointPolicy } from '../policy/human-point/human-point.types.ts';
import { createNonceStore } from '../policy/authority/nonce.ts';
import type { SessionTokens } from '../policy/session-tokens/session-tokens.ts';
import { loadSigningDevices, machineIdOf } from './devices.ts';
import type { SessionRuntime } from './session-runtime.ts';
import { createSessionPeerCheck, sessionRootsOf } from './session-peers.ts';
import { buildVerifierWiring } from './verifier-wiring/index.ts';

/**
 * API ядра в сборе (07 §API): дорога человека и панели (`buildApi`) + дорога модели
 * (`/v1/session/*`). Здесь же — откуда API знает, кто звонит: pid пира из таблицы TCP и дерево
 * сессий из журналов задач по таблице процессов (ревью F-15: раньше «никто не из сессии»).
 */

/**
 * Политика человека до конфига фазы 7: записи в трекер и фордж — «спрашивать»; настройки CLI в
 * копии (`.claude/**`: хуки исполняются вне прав шага) — пункт 5 и только с грантом (ревью F-12;
 * сам запрет правки — в судье права и оверлее CLI).
 */
export const CORE_HUMAN_POLICY: HumanPointPolicy = {
  actionClasses: [],
  pathGlobs: ['.claude/**'],
  grantRequired: [{ globs: ['.claude/**'], ops: ['edit'] }],
  trackerWrites: 'ask',
  forgeWrites: 'ask',
};

export interface BootApiDeps {
  registry: TaskRegistry;
  layout: CoreHomeLayout;
  coreToken: string;
  sessionTokens: SessionTokens;
  sessions: SessionRuntime;
  health: HealthInfo;
  /** Журнал ядра: непойманные дороги захвата и итог забора очереди названы, не немы (A2-F03). */
  note?: (event: string, data: Record<string, unknown>) => void;
}

export function buildCoreApi(deps: BootApiDeps): FastifyInstance {
  const { registry, sessionTokens } = deps;
  const verifier = buildVerifierWiring({
    registry,
    layout: deps.layout,
    ...(deps.note ? { note: deps.note } : {}),
  });
  const app = buildApi({
    registry,
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
      trustedHopPids: new Set(),
    },
    signature: {
      machineId: machineIdOf(deps.layout),
      devices: () => loadSigningDevices(deps.layout),
      now: Date.now,
    },
    health: deps.health,
    now: Date.now,
  });
  // Дорога модели (`/v1/session/*`, W2-C): мосты MCP сессий ходят сюда с токеном сессии.
  registerSessionTools(app, {
    registry,
    tokens: sessionTokens,
    tools: {
      ...verifier.verify,
      // Инструмент модели `check` — единый вход проверок (зона C), не ответ «проверки нет».
      check: verifier.queue.check,
      humanPolicy: CORE_HUMAN_POLICY,
    },
    // Кодек права даёт переходник прикреплённой сессии; сессии нет в рантайме (не прикреплена,
    // поток кончился) — вопрос о праве отказывается (503, fail-closed), а не разрешается.
    permitDeps: (task, binding) => deps.sessions.permitDeps(task, binding),
  });
  // Захват прогонов проверок (`/v1/session/capture*`): прокладка и обёртки PATH спрашивают тут.
  verifier.capture.register(app, sessionTokens);
  return app;
}
