import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CopyToGlobalResult, Group, GroupMember } from '@agentdeck/contracts';
import {
  adviceApplyRequestSchema,
  copyToGlobalRequestSchema,
  discoveryImportRequestSchema,
  groupOverrideRequestSchema,
  isForeignGlobal,
  parseGroupKey,
  projectGroupChoiceRequestSchema,
  scopeOf,
  type ProjectGroupChoiceView,
} from '@agentdeck/contracts/group-sources';
import type { ServerContext } from '../../context.ts';
import { listProjects } from '../../domains/chat/ChatProjects/ChatProjects.ts';
import { decorateDiscovery, importDiscovered } from '../../domains/group-discovery/import.ts';
import {
  DISCOVERY_BLOCK_KIND,
  discoveryView,
  readDiscoveryCache,
  runStateOf,
  startDiscovery,
} from '../../domains/group-discovery/run.ts';
import {
  projectSources,
  providerSources,
  type DiscoverySpec,
} from '../../domains/group-discovery/sources.ts';

import {
  ADVICE_BLOCK_KIND,
  adviseCopy,
  adviseMerge,
  applyAdvice,
  MERGE_BLOCK_KIND,
} from '../../domains/groups/advice/advice.ts';
import { pairsIn, readPairChoices, writeChoice } from '../../domains/groups/choice/choice.ts';
import { copyGroupToGlobal, type CopiedMember } from '../../domains/groups/copy.ts';
import { copyGroupToProvider } from '../../domains/groups/copy-foreign/copy-foreign.ts';
import { badGroupRequest, groupNotFound, GroupRequestError } from '../../domains/groups/errors.ts';
import { groupPrompt, type GroupAsk } from '../../domains/groups/model.ts';
import {
  disableOverride,
  enableOverride,
  readOverride,
} from '../../domains/groups/override/override.ts';
import { OVERRIDE_BLOCK_KIND, overrideTextFor } from '../../domains/groups/override-text.ts';
import { getProvider, isKnownProviderId, listProviders } from '../../providers/registry.ts';
import { groupAsk, groupDeps, parseGroupBody, sendGroupError } from '../group-ask.ts';
import { projectKey } from '../../lib/app-store/group-sources.ts';

/**
 * Группы по областям: обнаружение наборов в проектах и общих каталогах CLI,
 * копия проектной группы в общие (с советами модели), слияние с ушедшим
 * вперёд оригиналом, выбор группы пары в проекте и переопределение в проекте.
 * Логика — в доменах `groups/` и `group-discovery/`; здесь только разбор тела,
 * поиск группы и перевод отказов в ответ.
 */

function groupById(ctx: ServerContext, id: string): Group {
  const group = ctx.store.getGroups().find((item) => item.id === id);
  if (!group) throw groupNotFound();
  return group;
}

/**
 * Источники обнаружения: проекты из истории чатов и реестра панели, плюс общие
 * каталоги каждого CLI. Считаются на каждом запросе — проект мог появиться.
 */
function discoverySpecs(ctx: ServerContext): DiscoverySpec[] {
  const paths = ctx.location.paths;
  const chatProjects = listProjects(join(paths.root, 'projects')).map((project) => project.path);
  const registered = ctx.store.getProjects().map((project) => project.path);
  return [
    ...projectSources([...registered, ...chatProjects], {
      configRoot: paths.root,
      home: homedir(),
      registered,
    }),
    ...providerSources(listProviders(), paths, ctx.store.getSettings().claudeDirOverride),
  ];
}

/** Советы идут по участникам КОПИИ: их id и текст, который теперь лежит в общих. */
function copiedTexts(
  copied: readonly CopiedMember[],
): { kind: GroupMember['kind']; id: string; text: string }[] {
  return copied.map((item) => ({ kind: item.to.kind, id: item.to.id, text: item.content.text }));
}

function runDiscovery(
  app: FastifyInstance,
  ctx: ServerContext,
  specs: DiscoverySpec[],
  ask: GroupAsk,
): void {
  const appData = ctx.location.paths.appData;
  const prompt = groupPrompt(appData, 'group-discover', DISCOVERY_BLOCK_KIND);
  // Прогон долгий (вызов модели на источник) — ответ его не ждёт, ход читается опросом.
  const onUnreadable = (source: string, excerpt: string): void =>
    app.log.warn({ source, excerpt }, 'group discovery: unreadable model answer');
  void startDiscovery(appData, specs, ask, prompt, undefined, onUnreadable).catch(() => undefined);
}

/** `makeAsk` — вызов модели; тесты подают свой, без процессов и сети. */
export function registerGroupSourcesRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  makeAsk: (ctx: ServerContext) => GroupAsk = groupAsk,
): void {
  app.get('/api/groups/discovery', () => {
    const appData = ctx.location.paths.appData;
    const specs = discoverySpecs(ctx);
    // Первый заход на страницу запускает первый прогон сам: пустой список с
    // кнопкой «Найти» был бы шагом, который человек не выбирал.
    if (!readDiscoveryCache(appData).lastRunAt && !runStateOf(appData))
      runDiscovery(app, ctx, specs, makeAsk(ctx));
    return decorateDiscovery(discoveryView(appData, specs), ctx.store.getGroups(), appData, specs);
  });

  app.post('/api/groups/discovery/run', (_request, reply) => {
    runDiscovery(app, ctx, discoverySpecs(ctx), makeAsk(ctx));
    return reply.code(202).send({ ok: true });
  });

  app.post<{ Params: { key: string } }>('/api/groups/discovery/:key/import', (request, reply) => {
    try {
      const { lang } = parseGroupBody(discoveryImportRequestSchema, request.body ?? {});
      return importDiscovered(
        ctx.location.paths.appData,
        ctx.store,
        request.params.key,
        undefined,
        lang,
      );
    } catch (error) {
      return sendGroupError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/groups/:id/copy-to-global',
    async (request, reply) => {
      try {
        const deps = groupDeps(ctx);
        const source = groupById(ctx, request.params.id);
        const { provider } = parseGroupBody(copyToGlobalRequestSchema, request.body);
        if (provider && provider !== 'claude') {
          if (!isKnownProviderId(provider)) {
            throw new GroupRequestError(400, 'copy_target_unknown', 'group-copy-target-unknown', {
              provider,
            });
          }
          // Чужой CLI: перенос окружения делает копию; советы — только для Claude,
          // у чужого каталога нет описи, с которой модели сравнивать.
          const { group, warnings } = copyGroupToProvider(
            deps,
            source,
            getProvider(provider),
            getProvider('claude'),
            { override: ctx.store.getSettings().claudeDirOverride },
          );
          return { group, advice: [], warnings } satisfies CopyToGlobalResult;
        }
        const outcome = copyGroupToGlobal(deps, source);
        const prompt = groupPrompt(deps.paths.appData, 'group-advice', ADVICE_BLOCK_KIND);
        const advice = await adviseCopy(
          deps,
          makeAsk(ctx),
          prompt,
          outcome.group,
          copiedTexts(outcome.copied),
        );
        return {
          group: outcome.group,
          advice: advice.items,
          ...(advice.failed ? { adviceFailed: true as const } : {}),
          warnings: outcome.warnings,
        } satisfies CopyToGlobalResult;
      } catch (error) {
        return sendGroupError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/groups/:id/advice/apply',
    (request, reply) => {
      try {
        const group = groupById(ctx, request.params.id);
        const { items } = parseGroupBody(adviceApplyRequestSchema, request.body);
        return applyAdvice(groupDeps(ctx), group, items);
      } catch (error) {
        return sendGroupError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/groups/:id/merge-origin', async (request, reply) => {
    try {
      const deps = groupDeps(ctx);
      const group = groupById(ctx, request.params.id);
      const prompt = groupPrompt(deps.paths.appData, 'group-merge', MERGE_BLOCK_KIND);
      const advice = await adviseMerge(deps, makeAsk(ctx), prompt, group);
      return { group, advice };
    } catch (error) {
      return sendGroupError(reply, error);
    }
  });

  // Выбор у каждой пары свой: `group` (id или ключ любой стороны пары) называет,
  // чей выбор вернуть в `groupKey`; без него — выбор единственной пары проекта.
  app.get<{ Querystring: { path?: string; group?: string } }>(
    '/api/projects/group-choice',
    (request, reply): ProjectGroupChoiceView | FastifyReply => {
      const path = request.query.path?.trim();
      if (!path) return sendGroupError(reply, badGroupRequest('path'));
      const groups = ctx.store.getGroups();
      const choices = readPairChoices(ctx.location.paths.appData, groups, path);
      const pairs = pairsIn(groups, path);
      const named = request.query.group?.trim();
      const id = named ? (parseGroupKey(named)?.id ?? named) : undefined;
      const pair = id
        ? pairs.find((item) => item.project.id === id || item.global?.id === id)
        : pairs.length === 1
          ? pairs[0]
          : undefined;
      return { groupKey: pair ? (choices[pair.project.id] ?? null) : null, choices };
    },
  );

  app.put<{ Body: unknown }>('/api/projects/group-choice', (request, reply) => {
    try {
      const body = parseGroupBody(projectGroupChoiceRequestSchema, request.body);
      const groupKey = writeChoice(
        ctx.location.paths.appData,
        ctx.store.getGroups(),
        body.path,
        body.groupKey as Parameters<typeof writeChoice>[3],
      );
      const choices = readPairChoices(ctx.location.paths.appData, ctx.store.getGroups(), body.path);
      return { groupKey, choices };
    } catch (error) {
      return sendGroupError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/groups/:id/override',
    (request, reply) => {
      const path = request.query.path?.trim();
      if (!path) return sendGroupError(reply, badGroupRequest('path'));
      return readOverride(ctx.location.paths.appData, path);
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/groups/:id/override',
    async (request, reply) => {
      try {
        const appData = ctx.location.paths.appData;
        const global = groupById(ctx, request.params.id);
        if (scopeOf(global).kind !== 'global') {
          throw new GroupRequestError(409, 'group_not_global', 'group-not-global');
        }
        // Копия для другой CLI: файл переопределения читает Claude, а велел бы он
        // брать скиллы, которых в каталогах Claude нет.
        if (isForeignGlobal(global.scope)) {
          throw new GroupRequestError(409, 'override_claude_only', 'group-override-claude-only');
        }
        const body = parseGroupBody(groupOverrideRequestSchema, request.body);
        // Снимается только своё: запись другой группы на этом пути не трогается —
        // иначе тумблер копии B гасил переопределение, включённое копией A.
        if (!body.enabled) return disableOverride(appData, body.path, global.id);

        // Проектная группа — пара этой копии, а нет её — любая группа проекта:
        // именно её порядок работы переопределение и отменяет.
        const pairs = pairsIn(ctx.store.getGroups(), body.path);
        // Путь — проект, у которого есть группа, и не каталог, чей `.claude` —
        // сам конфиг панели: `$HOME` писал бы правило и запреты в общий `~/.claude`.
        if (pairs.length === 0) throw badGroupRequest('path: no project group there');
        if (projectKey(join(body.path, '.claude')) === projectKey(ctx.location.paths.root)) {
          throw badGroupRequest('path: its .claude is the config dir');
        }
        const project =
          pairs.find((pair) => pair.global?.id === global.id)?.project ?? pairs[0]?.project;
        const projectScope = project ? scopeOf(project) : undefined;
        if (projectScope?.kind === 'project' && projectScope.provider !== 'claude') {
          throw new GroupRequestError(409, 'override_claude_only', 'group-override-claude-only');
        }
        const prompt = groupPrompt(appData, 'group-override', OVERRIDE_BLOCK_KIND);
        const { text, denySkills } = await overrideTextFor(makeAsk(ctx), prompt, global, project);
        return enableOverride(appData, {
          groupId: global.id,
          projectPath: body.path,
          text,
          denySkills,
        });
      } catch (error) {
        return sendGroupError(reply, error);
      }
    },
  );
}
