import type { FastifyInstance } from 'fastify';
import type { Group } from '@agentdeck/contracts';
import { groupKnobsEditSchema, type GroupKnobsView } from '@agentdeck/contracts/group-knobs';
import type { ServerContext } from '../../context.ts';
import { groupNotFound } from '../../domains/groups/errors.ts';
import {
  applyKnobsEdit,
  groupKnobsView,
  KNOBS_BLOCK_KIND,
} from '../../domains/groups/knobs/knobs.ts';
import { groupPrompt, type GroupAsk } from '../../domains/groups/model.ts';
import { groupAsk, groupDeps, parseGroupBody, sendGroupError } from '../group-ask.ts';

/**
 * «Числа» группы: сколько прогонов делают её скиллы (`domains/groups/knobs/knobs.ts`).
 * GET отвечает сразу — неготовые скиллы выписываются в фоне и приходят вторым
 * запросом; PUT закрепляет числа (и равные умолчанию), `null` возвращает «Авто».
 */

function groupById(ctx: ServerContext, id: string): Group {
  const group = ctx.store.getGroups().find((item) => item.id === id);
  if (!group) throw groupNotFound();
  return group;
}

/** `makeAsk` — вызов модели; тесты подают свой, без процессов и сети. */
export function registerGroupKnobsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  makeAsk: (ctx: ServerContext) => GroupAsk = groupAsk,
): void {
  const view = (group: Group): GroupKnobsView => {
    const deps = groupDeps(ctx);
    return groupKnobsView({
      deps,
      ask: makeAsk(ctx),
      prompt: groupPrompt(deps.paths.appData, 'group-knobs', KNOBS_BLOCK_KIND),
      group,
      onError: (error, skillId) =>
        app.log.warn({ err: error, skillId, groupId: group.id }, 'group knobs extraction failed'),
    });
  };

  app.get<{ Params: { id: string } }>('/api/groups/:id/knobs', (request, reply) => {
    try {
      return view(groupById(ctx, request.params.id));
    } catch (error) {
      return sendGroupError(reply, error);
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/groups/:id/knobs', (request, reply) => {
    try {
      const group = groupById(ctx, request.params.id);
      const edit = parseGroupBody(groupKnobsEditSchema, request.body);
      const values = applyKnobsEdit(view(group).knobs, group.knobs, edit.values);
      const { knobs: _dropped, ...rest } = group;
      const saved = ctx.store.saveGroup(
        Object.keys(values).length > 0 ? { ...rest, knobs: values } : rest,
      );
      return view(saved);
    } catch (error) {
      return sendGroupError(reply, error);
    }
  });
}
