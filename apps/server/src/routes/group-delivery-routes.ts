import type { FastifyInstance } from 'fastify';
import type { Group } from '@agentdeck/contracts';
import { scopeProvider } from '@agentdeck/contracts/group-sources';
import type { GroupDelivery } from '@agentdeck/contracts/group-delivery';
import type { ServerContext } from '../context.ts';
import { groupNotFound } from '../domains/groups/errors.ts';
import { decideRunLayer, groupLeaves } from '../domains/groups/run-layer.ts';
import { serverText } from '../lib/server-texts.ts';
import { getActiveProviderId, getProvider, isKnownProviderId } from '../providers/registry.ts';
import { sendGroupError } from './group-ask.ts';

/**
 * «Что из группы дойдёт до CLI»: `GET /api/groups/:id/delivery?provider=`.
 *
 * Только чтение — тот же чистый план, что строит запуск (`decideRunLayer`),
 * без записи слоя: карточка группы показывает человеку по участнику, что
 * доедет до прогона этого CLI и что нет — с причиной, а не узнаёт это из
 * ленты после запуска. Без `provider` — активный CLI.
 */
export function registerGroupDeliveryRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { id: string }; Querystring: { provider?: string } }>(
    '/api/groups/:id/delivery',
    (request, reply) => {
      const providerId = request.query.provider ?? getActiveProviderId(ctx.store);
      if (!isKnownProviderId(providerId)) {
        const params = { id: providerId };
        return reply.code(400).send({
          error: 'Незнакомый CLI',
          message: serverText('provider-unknown', params),
          messageCode: 'provider-unknown',
          params,
        });
      }
      const all = ctx.store.getGroups();
      const group = all.find((item) => item.id === request.params.id);
      if (!group) return sendGroupError(reply, groupNotFound());
      return groupDelivery(ctx, all, group, providerId);
    },
  );
}

function groupDelivery(
  ctx: ServerContext,
  all: readonly Group[],
  group: Group,
  providerId: string,
): GroupDelivery {
  const provider = getProvider(providerId);
  const base = { groupId: group.id, provider: provider.id, cliName: provider.name };
  const owner = scopeProvider(group.scope);

  // Группа в файлах САМОГО этого CLI (Claude — его каталоги, копия для другого
  // CLI — его файлы): действует тумблером этих файлов, слой не нужен.
  if (owner === providerId) {
    return {
      ...base,
      model: 'claude-files',
      enabled: group.isEnabled,
      delivered: groupLeaves(all, [group]).map((leaf) => ({
        group: group.id,
        member: `${leaf.member.kind}:${leaf.member.id}`,
      })),
      refused: [],
      envNames: Object.keys(group.env ?? {}),
    };
  }
  // Копия для другого CLI этому не достаётся ни в какой модели: её файлы
  // лежат там, куда этот CLI не смотрит, а слой собирается из групп Claude.
  if (owner !== 'claude') {
    return { ...base, model: 'none', enabled: false, delivered: [], refused: [], envNames: [] };
  }

  const enabled = group.enabledFor?.[providerId] === true;
  const decision = decideRunLayer({ paths: ctx.location.paths, store: ctx.store }, provider, [
    group,
  ]);
  if (decision.model === 'none') {
    return { ...base, model: 'none', enabled, delivered: [], refused: [], envNames: [] };
  }
  return {
    ...base,
    model: 'run-layer',
    enabled,
    delivered: decision.plan.delivered,
    refused: decision.plan.refused,
    envNames: Object.keys(decision.plan.env),
    digest: decision.plan.digest,
  };
}
