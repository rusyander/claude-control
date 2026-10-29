import { join } from 'node:path';
import type { Route } from '@agentdeck/contracts/core/routes';
import { absent, readFact } from '../../../../lib/facts/read-fact.ts';
import { resolveExecutable } from '../../../../platform/exec-resolve.ts';
import { pathExists } from '../../../../platform/safe-io/files.ts';
import { liveEndpoint } from '../../../endpoint.ts';
import { readLeaseState, serverRef } from '../lease-state.ts';
import { attachRouter } from '../server.ts';
import type { OwnContext } from './context.ts';

/** Факты маршрута `local:own`: доступность, модели на диске, лимит слота, цена, окно. */
export function createOwnReads(ctx: OwnContext): Route['read'] {
  const { options, held } = ctx;
  return {
    availability: () =>
      readFact('route.availability', () => {
        if (held.size > 0) return { state: 'up' as const };
        // Сервер стартует из свежего каталога аренды `<workRoot>/<leaseId>` (server.ts): относительный
        // путь разрешается оттуда же — от любого ребёнка workRoot, не от cwd ядра.
        const found = resolveExecutable(options.server.command, {
          env: { ...process.env } as Record<string, string>,
          cwd: join(options.workRoot, 'next-lease'),
        });
        return found.ok ? { state: 'startable' as const } : absent();
      }),
    models: () =>
      readFact('route.models', () =>
        options.models
          .filter((model) => pathExists(model.path))
          .map((model) => ({
            id: model.id,
            sizeBytes: model.sizeBytes,
            ...(model.contextTokens === undefined ? {} : { contextTokens: model.contextTokens }),
            ...(model.tools === undefined ? {} : { tools: model.tools }),
          })),
      ),
    limit: () => readFact('route.limit', () => ({ kind: 'slot' as const, slots: 1 })),
    price: () => readFact('route.price', () => ({ unit: 'gpu-time' as const })),
    credential: () =>
      readFact('route.credential', () => ({ kind: 'none' as const, present: true })),
    context: (modelId) =>
      readFact('route.context', () => {
        const tokens = options.models.find((model) => model.id === modelId)?.contextTokens;
        return tokens === undefined ? absent() : tokens;
      }),
  };
}

/**
 * Адрес сервера аренды. Перезапущенное ядро спрашивает адрес раньше первой выдачи слота: запись
 * аренды читается здесь же, ссылка сервера в аренде должна совпасть с записью. Адрес — только
 * живому по личности серверу, чей порт отвечает (F-73): ни запись, ни держатель в памяти этого
 * не доказывают — сервер мог умереть, а его номер и порт уйти другому процессу.
 */
export function createOwnEndpoint(ctx: OwnContext): Route['endpoint'] {
  const { options, id, held } = ctx;
  return async (lease, record) => {
    const entry = held.get(lease.leaseId);
    let router = entry?.router;
    let dialect = entry?.dialect;
    if (!entry) {
      const state = readLeaseState(join(options.workRoot, lease.leaseId));
      const ref = lease.resources.find((r) => r.kind === 'model-server')?.ref;
      if (
        state?.server &&
        state.routeId === id &&
        ref === serverRef(state.server.identity, state.server.origin)
      ) {
        router = attachRouter(state.server);
        dialect = state.dialect;
      }
    }
    const live = router;
    return liveEndpoint({
      lease,
      server: live
        ? `model server ${serverRef(live.identity, live.origin)}`
        : `own lease ${lease.leaseId}`,
      ...(live && dialect
        ? {
            target: {
              identity: live.identity,
              endpoint: { baseUrl: live.origin, dialect, keyRef: null },
            },
          }
        : {}),
      isAlive: async (identity, question) => {
        const read = await ctx.liveness(identity, question);
        return read.live === 'absent' ? 'dead' : read.live;
      },
      // У маршрутизатора нет пути личности: личность доказывает процесс, проба — что порт жив.
      health: async () =>
        (await live?.client.healthy()) ? 'answers' : { unknown: 'GET /health did not answer' },
      record,
    });
  };
}
