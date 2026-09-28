import type { FastifyInstance } from 'fastify';
import type { Group } from '@agentdeck/contracts';
import { pathPromoteNamedRequestSchema } from '@agentdeck/contracts/group-describe';
import {
  PATH_STEP_BLOCK_KIND,
  pathStepDraftRequestSchema,
  type GroupPathView,
} from '@agentdeck/contracts/group-path';
import type { ServerContext } from '../context.ts';
import type { EntityToggleDeps } from '../domains/entity-toggle.ts';
import { badGroupRequest, groupNotFound } from '../domains/groups/errors.ts';
import { memberContent, memberScope } from '../domains/groups/members.ts';
import { DESCRIBE_BLOCK_KIND, type Describer } from '../domains/groups/describe.ts';
import {
  describedProposal,
  groupMembersView,
  resourceCatalogView,
} from '../domains/groups/describe-views.ts';
import { groupPrompt, type GroupAsk } from '../domains/groups/model.ts';
import { buildPath, type PathSkill } from '../domains/groups/path.ts';
import { normalizePathSteps, withPathSteps } from '../domains/groups/path-edit.ts';
import { runLegacyGroupMigrations } from '../domains/groups/legacy-migrations.ts';
import { promotePathStep } from '../domains/groups/promote.ts';
import { draftPathStep } from '../domains/groups/step-assistant.ts';
import {
  resourceSummary,
  SUMMARY_BLOCK_KIND,
  type SummaryType,
} from '../domains/resource-summary.ts';
import { groupAsk, groupDeps, parseGroupBody, sendGroupError } from './group-ask.ts';
import { readAgentImages } from '../lib/agent-images.ts';

/**
 * «Путь» группы: стадии конвейера, шаги скиллов-участников и свои шаги
 * человека одним списком; правка своих шагов, ассистент шага, «сделать
 * глобальным» и ленивые сводки ресурсов для карточек.
 */

const SUMMARY_TYPES: readonly SummaryType[] = ['skill', 'hook', 'rule'];

function groupById(ctx: ServerContext, id: string): Group {
  const group = ctx.store.getGroups().find((item) => item.id === id);
  if (!group) throw groupNotFound();
  return group;
}

/**
 * Скиллы-участники с текстом: из них выводятся шаги «как у скилла». Скилл,
 * который человек поставил в путь шагом-ссылкой, своим блоком после стадии
 * работы не рисуется: он идёт там, где стоит его шаг, — блок был бы вторым
 * прогоном того же скилла. Участником он остаётся: так он включается вместе с
 * группой, и шаг «примени скилл X» не упирается в выключенный скилл.
 */
function pathSkills(
  deps: EntityToggleDeps,
  group: Group,
  onUnreadable: (skillId: string) => void = () => undefined,
): PathSkill[] {
  const referenced = new Set(
    (group.path?.steps ?? []).flatMap((step) =>
      step.kind === 'resource' && step.resource?.type === 'skill' && !step.within
        ? [step.resource.id]
        : [],
    ),
  );
  return group.members
    .filter((member) => member.kind === 'skill' && !referenced.has(member.id))
    .flatMap((member) => {
      const content = memberContent(deps, memberScope(group, member), member, () =>
        onUnreadable(member.id),
      );
      return content ? [{ id: member.id, body: content.text }] : [];
    });
}

function pathView(deps: EntityToggleDeps, group: Group): GroupPathView {
  const unreadable: string[] = [];
  const view = buildPath(
    group,
    pathSkills(deps, group, (id) => unreadable.push(id)),
  );
  return unreadable.length > 0 ? { ...view, unreadable } : view;
}

/** `makeAsk` — вызов модели; тесты подают свой, без процессов и сети. */
export function registerGroupPathRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  makeAsk: (ctx: ServerContext) => GroupAsk = groupAsk,
): void {
  const describer = (): Describer => {
    const appData = ctx.location.paths.appData;
    return {
      appData,
      ask: makeAsk(ctx),
      prompt: groupPrompt(appData, 'group-describe', DESCRIBE_BLOCK_KIND),
      onError: (error, key) => app.log.warn({ err: error, key }, 'resource describe failed'),
    };
  };

  // Перенос старого «Порядка работы» в путь — при старте; смена каталога на лету
  // зовёт тот же проход из `config-routes.ts`.
  app.addHook('onReady', async () => {
    runLegacyGroupMigrations(groupDeps(ctx), app.log);
  });

  app.get<{ Params: { id: string } }>('/api/groups/:id/path', (request, reply) => {
    try {
      return pathView(groupDeps(ctx), groupById(ctx, request.params.id));
    } catch (error) {
      return sendGroupError(reply, error);
    }
  });

  // Участники: строка из их же файлов сразу, имя и «что делает» на двух языках —
  // из кэша описаний; неописанные описываются в фоне и названы в `pending`.
  app.get<{ Params: { id: string } }>('/api/groups/:id/members', (request, reply) => {
    try {
      const group = groupById(ctx, request.params.id);
      return groupMembersView(groupDeps(ctx), describer(), group);
    } catch (error) {
      return sendGroupError(reply, error);
    }
  });

  // «Выбрать готовый»: общие ресурсы и (с `path`) ресурсы проекта, с тем же кэшем описаний.
  app.get<{ Querystring: { path?: string } }>('/api/groups/resource-catalog', (request, reply) => {
    try {
      const path = request.query.path?.trim() || undefined;
      return resourceCatalogView(groupDeps(ctx), describer(), path);
    } catch (error) {
      return sendGroupError(reply, error);
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/groups/:id/path/steps',
    (request, reply) => {
      try {
        const deps = groupDeps(ctx);
        const group = groupById(ctx, request.params.id);
        const saved = ctx.store.saveGroup(withPathSteps(group, normalizePathSteps(request.body)));
        return pathView(deps, saved);
      } catch (error) {
        return sendGroupError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/groups/:id/path/draft',
    // Тело с картинками: до восьми по 3,75 МБ в base64 — предел по умолчанию (1 МБ) мал.
    { bodyLimit: 48 * 1024 * 1024 },
    async (request, reply) => {
      try {
        const deps = groupDeps(ctx);
        const group = groupById(ctx, request.params.id);
        const body = parseGroupBody(pathStepDraftRequestSchema, request.body);
        const images = readAgentImages((request.body as { images?: unknown } | null)?.images);
        if (!images.ok) return reply.code(400).send(images.refusal);
        const prompt = groupPrompt(deps.paths.appData, 'path-step-author', PATH_STEP_BLOCK_KIND);
        const describe = describer();
        return await draftPathStep(
          deps,
          describe.ask,
          prompt,
          group,
          body,
          undefined,
          (p, raw) => describedProposal(deps, describe, p, raw),
          images.images,
        );
      } catch (error) {
        return sendGroupError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/groups/:id/path/promote',
    (request, reply) => {
      try {
        const deps = groupDeps(ctx);
        const group = groupById(ctx, request.params.id);
        const body = parseGroupBody(pathPromoteNamedRequestSchema, request.body);
        return pathView(deps, promotePathStep(deps, group, body));
      } catch (error) {
        return sendGroupError(reply, error);
      }
    },
  );

  app.get<{ Querystring: { type?: string; id?: string; path?: string } }>(
    '/api/resources/summary',
    async (request, reply) => {
      try {
        const { type, id, path } = request.query;
        if (!type || !SUMMARY_TYPES.includes(type as SummaryType)) throw badGroupRequest('type');
        if (!id?.trim()) throw badGroupRequest('id');
        const deps = groupDeps(ctx);
        const prompt = groupPrompt(deps.paths.appData, 'resource-summary', SUMMARY_BLOCK_KIND);
        return await resourceSummary(
          deps,
          makeAsk(ctx),
          prompt,
          type as SummaryType,
          id.trim(),
          path?.trim() || undefined,
        );
      } catch (error) {
        return sendGroupError(reply, error);
      }
    },
  );
}
