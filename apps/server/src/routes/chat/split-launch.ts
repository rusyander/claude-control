import { resolve } from 'node:path';
import type { TaskSplitProposal, TaskSplitResult } from '@agentdeck/contracts/task-split';
import {
  clampAssignment,
  loweredWorkPrompt,
  manualAssignment,
  parseAssignments,
  planAssignment,
} from '@agentdeck/contracts/model-cascade';
import {
  composeGroupNotes,
  planStagePrompt,
  TASK_MAX_CHARS,
} from '@agentdeck/contracts/split-plan';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession.ts';
import type { TreeStartGate } from '../../domains/chat/tree-pause.ts';
import {
  makeSplitGit,
  splitTasks,
  type SplitGroupContext,
  type SplitLink,
  type SplitStart,
} from '../../domains/chat/ChatSplit.ts';
import { initiativePrompt } from '../../domains/chat/initiative.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { apiTokenPath } from '../../lib/api-token.ts';
import { activateGroupsQuietly } from '../../domains/group-activation.ts';
import {
  cascadeCeilingFor,
  expandAssignedModel,
  isCascadeEnabled,
} from '../../domains/model-cascade.ts';
import { planForeignAssignment } from '../../domains/provider-cascade.ts';
import { bootstrapCommandFor } from '../../domains/project-git.ts';
import { readMergeRequestByUrl } from '../../domains/integrations/forge.ts';
import { readIntegrations, readToken } from '../../domains/integrations/store.ts';
import { createChat, type ProviderChatService } from '../../domains/provider-chat.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { activeCliCommand } from '../../providers/cli.ts';

/**
 * Запуск групп разделения — всё, что стоит между «завести копию» и «прогон
 * пошёл»: подбор модели, связь с родителем, старт у Claude или у чужого CLI,
 * разбор уровня 1.
 *
 * Вынесено из маршрута, потому что заводить группы теперь умеют ДВА места:
 * сам `POST /api/chat/split` (подбор выключен — как раньше, разом) и конвейер
 * уровней (Т1), который заводит группы порциями по итогу разбора, через часы и
 * через перезапуск сервера. Обоим нужны одни и те же замыкания, и вторая копия
 * разошлась бы с первой на первой же правке.
 */

export interface SplitLaunchDeps {
  runs: ChatRunRegistry;
  providerChats: ProviderChatService;
  session: ChatSession;
  gate?: TreeStartGate;
  /** Куда писать сбой включения набора — форма и у fastify, и у консоли одна. */
  log: { warn: (detail: { err: unknown }, message: string) => void };
}

/** Что человек попросил при разделении — то, что конвейер хранит в записи. */
export interface SplitRequest {
  projectPath: string;
  parentChatId?: string;
  allowEdits?: boolean;
  model?: string;
  effort?: string;
  assignments?: unknown;
}

export interface SplitLauncher {
  /** Чужой CLI: связей и уровней нет, прогон идёт его хранилищем. */
  isForeign: boolean;
  /**
   * Подбор включён и потолок распознан — группы идут через уровни (Т1):
   * разбор в корне, план в копии, затем работа.
   */
  planned: boolean;
  /** Завести копии и прогоны для групп предложения (все или порцию). */
  launch: (
    proposal: TaskSplitProposal,
    options: {
      startRuns: boolean;
      groups?: number[];
      context?: SplitGroupContext;
      /** С какого звена стартуют чаты; нет — с работы, как до Т1. Уровни ставит конвейер. */
      stage?: 'plan' | 'work';
    },
  ) => Promise<TaskSplitResult>;
  /** Запустить разбор (уровень 1) в корне репозитория на потолке. */
  startTriage: (prompt: string) => { chatId: string; started: boolean; deferred: boolean };
}

const TRIAGE_TITLE = 'Разбор разделения';

export function createSplitLauncher(
  ctx: ServerContext,
  deps: SplitLaunchDeps,
  request: SplitRequest,
): SplitLauncher {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;
  const dir = resolve(request.projectPath);
  const { allowEdits, model, effort, parentChatId } = request;

  const provider = getActiveProvider(ctx.store);
  // Чужой CLI ведёт разговор своим хранилищем, и подбор модели у него устроен
  // иначе — от лестницы провайдера, а не от потолка разговора (см.
  // `domains/provider-cascade.ts`). Развилка одна на весь запуск.
  const isForeign = provider.id !== 'claude';
  // Замены человека: чем бы ни оказалось поле, отсюда выходит карта понятных
  // значений — незнакомое отброшено, потолок всё равно держится ниже.
  const manual = parseAssignments(request.assignments);

  // Правило проекта одно на обе ветки: выключив подбор в репозитории, человек
  // выключил его и чужому CLI — тумблер стоит на проекте, а не на провайдере.
  const cascadeEntries = ctx.store.getProjectCascadeEntries();
  // Потолок разговора и правило проекта: `undefined` — подбор здесь выключен,
  // и дальше всё идёт ровно как до партии подбора (дети = выбранная модель).
  //
  // У чужого провайдера потолка НЕТ вовсе, и подставлять сюда настройку панели
  // нельзя: в ней имя модели Claude, а прогон пойдёт кодексом.
  const ceiling = isForeign
    ? undefined
    : cascadeCeilingFor({ entries: cascadeEntries, settings: ctx.store.getSettings() }, dir, {
        model,
        effort,
      });
  // Каталог моделей: им алиас разворачивается в свежую модель семейства.
  const catalog = ctx.models.current(provider.modelVendors ?? []).models;
  // Потолок в том виде, в каком с ним можно ЗАПУСТИТЬ прогон: `max` срезан до
  // `xhigh`, незнакомая глубина — до пустой строки. Алиас разворачивается и
  // здесь: этот потолок уезжает в связь, и по нему пойдут разбор, план и ревью
  // — на том же поколении, что выбрал человек (см. `expandAssignedModel`).
  const runnableCeiling = ceiling
    ? (() => {
        const clamped = clampAssignment({}, ceiling);
        return { ...clamped, model: expandAssignedModel(catalog, clamped.model) };
      })()
    : undefined;
  const planned = Boolean(runnableCeiling) && Boolean(parentChatId);

  /**
   * Ветка MR для ревью-группы (Т7). Спрашиваем фордж, а не верим блоку агента:
   * он называет ветку по памяти, а ошибка тут тихая — копия встанет на похожую
   * ветку, и ревью уверенно напишет замечания не про тот код.
   *
   * Интеграции нет — `undefined`, и разделение спокойно берёт ветку из блока
   * (или заводит копию от базы с пометкой): ревью по ссылке возможно и так.
   */
  const resolveReview = async (review: { url: string }) => {
    const settings = readIntegrations(ctx.store).forge;
    const token = readToken(ctx.location.paths.appData, 'forge');
    if (!settings.enabled || !token) return undefined;
    try {
      const mr = await readMergeRequestByUrl(review.url, token);
      return mr ? { branch: mr.branch } : undefined;
    } catch (error) {
      deps.log.warn({ err: error }, 'split review: merge request unreadable');
      return undefined;
    }
  };

  const git = makeSplitGit(
    (projectDir) => ctx.store.getWorktreeMirror(projectDir),
    async (projectDir, copy) => {
      const command = bootstrapCommandFor(copy, ctx.store.getWorktreeMirror(projectDir).bootstrap);
      return command ? ctx.worktreeBootstraps.run(copy, command) : undefined;
    },
  );

  /**
   * Чем делать группу. Считается здесь, потому что здесь известны обе половины
   * потолка — оверрайд шапки этого разговора и настройка панели, — а также
   * правило проекта. Разделение только разносит ответ.
   */
  const assign = isForeign
    ? (group: TaskSplitProposal['groups'][number], prompt: string) =>
        isCascadeEnabled(cascadeEntries, dir)
          ? planForeignAssignment(provider, catalog, {
              ...(group.kind ? { kind: group.kind } : {}),
              tasks: group.tasks.length,
              length: prompt.length,
            })
          : undefined
    : ceiling
      ? (group: TaskSplitProposal['groups'][number], prompt: string, index: number) => {
          const auto = planAssignment(
            {
              ...(group.kind ? { kind: group.kind } : {}),
              ...(group.model ? { model: group.model } : {}),
              ...(group.effort ? { effort: group.effort } : {}),
              tasks: group.tasks.length,
              length: prompt.length,
            },
            ceiling,
          );
          // Замена человека сильнее подбора и действует ВНИЗ тоже: он видел
          // задачи группы. Класс при этом остаётся распознанным.
          const wish = manual.get(index);
          const plan = wish ? manualAssignment(wish, ceiling, auto.kind) : auto;
          // Алиас — в свежую модель семейства, последним шагом: сравнение силы
          // идёт по алиасам, а прогону нужно имя без прошлого поколения.
          return { ...plan, model: expandAssignedModel(catalog, plan.model) };
        }
      : undefined;

  /**
   * Дерево в списке чатов. Пишем ДО запуска прогона и только по удавшимся
   * группам (см. `SplitLink`). Связь пишется только у Claude: у чужого CLI
   * разговор заводит его хранилище со своим идентификатором.
   *
   * Звено `plan` (Т1) кладёт в связь всё, из чего после плана соберётся работа:
   * задание, границы, назначение работы (`workModel/Effort`, `lowered`) — план
   * сам идёт на потолке, а работа на подобранной ступени.
   */
  const link: SplitLink | undefined =
    parentChatId && !isForeign
      ? ({ chatId, title, branch, path, assignment, stage, group, prompt, context, review }) => {
          const notes = composeGroupNotes({
            ...(group.notes ? { notes: group.notes } : {}),
            ...(context?.predecessors ? { predecessors: context.predecessors } : {}),
            ...(context?.base ? { base: context.base } : {}),
            ...(context?.holdAnswer ? { holdAnswer: context.holdAnswer } : {}),
          });
          const ceilingFields = runnableCeiling
            ? { ceilingModel: runnableCeiling.model, ceilingEffort: runnableCeiling.effort }
            : {};
          if (stage === 'plan' && assignment && runnableCeiling) {
            ctx.store.setChatLink(chatId, {
              parentChatId,
              title,
              branch,
              createdAt: new Date().toISOString(),
              stage: 'plan',
              model: runnableCeiling.model,
              effort: runnableCeiling.effort,
              workModel: assignment.model,
              workEffort: assignment.effort,
              lowered: assignment.lowered,
              ...(assignment.kind ? { kind: assignment.kind } : {}),
              ...ceilingFields,
              task: prompt.slice(0, TASK_MAX_CHARS),
              ...(group.owns && group.owns.length > 0 ? { owns: group.owns } : {}),
              ...(notes ? { notes } : {}),
            });
            return;
          }
          // Ревью по ссылке (Т7): стадия у группы своя, и в связь ложится всё, из
          // чего потом собирается карточка решения, — предмет, ветка и каталог
          // копии. Каталог именно здесь: решение приходит через часы, из хаба
          // или с телефона, и взять его в тот момент больше неоткуда.
          if (review) {
            ctx.store.setChatLink(chatId, {
              parentChatId,
              title,
              branch,
              createdAt: new Date().toISOString(),
              stage: 'review',
              ...(assignment
                ? {
                    model: assignment.model,
                    effort: assignment.effort,
                    ...(assignment.kind ? { kind: assignment.kind } : {}),
                  }
                : {}),
              ...ceilingFields,
              review: {
                url: review.url,
                ...(review.branch ? { branch: review.branch } : {}),
                ...(review.onMrBranch ? {} : { onMrBranch: false }),
                path,
              },
            });
            return;
          }
          ctx.store.setChatLink(chatId, {
            parentChatId,
            title,
            branch,
            createdAt: new Date().toISOString(),
            // Назначение живёт в связи, а не только в прогоне: второе сообщение
            // ребёнку приходит уже без него.
            ...(assignment
              ? {
                  model: assignment.model,
                  effort: assignment.effort,
                  lowered: assignment.lowered,
                  stage: 'work',
                  ...(assignment.kind ? { kind: assignment.kind } : {}),
                  // Потолок ЭТОГО разговора — на нём пойдёт ревью работы.
                  ...ceilingFields,
                }
              : {}),
          });
        }
      : undefined;

  /** Прогон Claude — тот же путь, что и у обычной отправки в чат проекта. */
  function startClaude(input: Parameters<SplitStart>[0]): boolean {
    const { chatId, prompt, cwd, assignment, stage, group, title, branch, context } = input;
    const settings = ctx.store.getSettings();
    // Чат, выделенный под одну группу, делить дальше не предлагается.
    deps.runs.muteSplit(chatId);
    // Автоподтверждение наследуется от родителя: делят как раз для того, чтобы
    // не сидеть над каждым.
    if (parentChatId) deps.session.inherit([parentChatId], chatId);

    const isPlan = stage === 'plan' && assignment && runnableCeiling;
    const initiative = [
      initiativePrompt(settings, { splitMuted: true }),
      // План идёт на потолке без права правок — планки сдачи ему не надо; её
      // получит работа, когда план кончится (`stageAppendPrompt`).
      !isPlan && assignment?.lowered ? loweredWorkPrompt(assignment.kind) : '',
    ]
      .filter(Boolean)
      .join(' ');
    const meta = {
      projectPath: cwd,
      // Понижённая работа попадает в журнал сдачи вместе с классом; план — нет,
      // он идёт на потолке.
      ...(!isPlan && assignment?.lowered
        ? {
            lowered: {
              model: assignment.model,
              effort: assignment.effort,
              ...(assignment.kind ? { kind: assignment.kind } : {}),
            },
          }
        : {}),
    };
    const runPrompt = isPlan
      ? planStagePrompt({
          title,
          task: prompt,
          branch,
          ...(group.owns && group.owns.length > 0 ? { owns: group.owns } : {}),
          ...(() => {
            const notes = composeGroupNotes({
              ...(group.notes ? { notes: group.notes } : {}),
              ...(context?.predecessors ? { predecessors: context.predecessors } : {}),
              ...(context?.base ? { base: context.base } : {}),
              ...(context?.holdAnswer ? { holdAnswer: context.holdAnswer } : {}),
            });
            return notes ? { notes } : {};
          })(),
          ...(assignment.kind ? { kind: assignment.kind } : {}),
          workModel: assignment.model,
        })
      : prompt;
    const options = {
      prompt: runPrompt,
      cwd,
      command: activeCliCommand(ctx.store),
      // План — на потолке; работа — назначением (оно ИЗ потолка и выведено).
      model: isPlan ? runnableCeiling.model : (assignment?.model ?? (model || settings.chatModel)),
      effort: isPlan
        ? runnableCeiling.effort
        : (assignment?.effort ?? (effort || settings.chatEffort)),
      permissionMode: allowEdits ? 'acceptEdits' : 'default',
      permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
      ...(initiative ? { appendSystemPrompt: initiative } : {}),
    };
    // Родитель стоит на паузе — ребёнок заведён (связь есть), но не запущен.
    if (deps.gate?.defer('split', chatId, options, meta)) return false;
    return deps.runs.start(chatId, options, meta);
  }

  /**
   * Разговор чужого CLI. Идентификатор здесь СВОЙ (его выдаёт хранилище
   * провайдера); назначение и стадия уезжают в шапку разговора
   * (`domains/provider-chat/cascade.ts`).
   */
  function startForeign(input: Parameters<SplitStart>[0]): boolean {
    const { title, prompt, cwd, branch, assignment } = input;
    const appData = ctx.location.paths.appData;
    const created = createChat(appData, provider.id, {
      title,
      workdir: cwd,
      ...(assignment ? { model: assignment.model, effort: assignment.effort } : {}),
      ...(assignment?.lowered
        ? {
            cascade: {
              stage: 'work' as const,
              group: title,
              branch,
              lowered: true,
              workModel: assignment.model,
              workEffort: assignment.effort,
              ...(assignment.kind ? { kind: assignment.kind } : {}),
            },
          }
        : {}),
    });
    if (!created) return false;
    const initiative = [
      initiativePrompt(ctx.store.getSettings(), { splitMuted: true, foreign: true }),
      assignment?.lowered ? loweredWorkPrompt(assignment.kind, { reviewer: 'cli' }) : '',
    ]
      .filter(Boolean)
      .join(' ');
    const outcome = deps.providerChats.send(
      appData,
      provider.id,
      created.id,
      { text: prompt },
      { provider, models: catalog, ...(initiative ? { systemPrefix: initiative } : {}) },
    );
    return outcome.ok;
  }

  const start: SplitStart = (input) => {
    // Набор, привязанный к проекту, включается и здесь: копия репозитория
    // считается тем же проектом.
    activateGroupsQuietly(
      { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
      input.cwd,
      (error) => deps.log.warn({ err: error }, 'group activation failed'),
    );
    return isForeign ? startForeign(input) : startClaude(input);
  };

  return {
    isForeign,
    planned,
    launch: (proposal, options) =>
      splitTasks({
        projectPath: dir,
        proposal,
        startRuns: options.startRuns,
        git,
        ...(assign ? { assign } : {}),
        ...(link ? { link } : {}),
        resolveReview,
        start,
        ...(options.groups ? { groups: options.groups } : {}),
        // План только там, где есть потолок: без него планировать не на чем.
        stage: options.stage === 'plan' && runnableCeiling ? 'plan' : 'work',
        ...(options.context ? { context: options.context } : {}),
      }),
    startTriage: (prompt) => {
      const chatId = `new-${Date.now()}-triage`;
      if (!runnableCeiling || !parentChatId) return { chatId, started: false, deferred: false };
      // Связь — ДО запуска (см. `SplitLink`): по ней разбор висит под родителем
      // с подписью «разбор», а его завершение находит свою запись конвейера.
      ctx.store.setChatLink(chatId, {
        parentChatId,
        title: TRIAGE_TITLE,
        createdAt: new Date().toISOString(),
        stage: 'triage',
        model: runnableCeiling.model,
        effort: runnableCeiling.effort,
        ceilingModel: runnableCeiling.model,
        ceilingEffort: runnableCeiling.effort,
      });
      deps.runs.muteSplit(chatId);
      deps.session.inherit([parentChatId], chatId);
      const initiative = initiativePrompt(ctx.store.getSettings(), { splitMuted: true });
      const options = {
        prompt,
        cwd: dir,
        command: activeCliCommand(ctx.store),
        model: runnableCeiling.model,
        effort: runnableCeiling.effort,
        // Разбор только читает: права на правки ему не выдаются даже при
        // «разрешить правки» у детей.
        permissionMode: 'default',
        permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
        ...(initiative ? { appendSystemPrompt: initiative } : {}),
      };
      const meta = { projectPath: dir };
      if (deps.gate?.defer('triage', chatId, options, meta)) {
        return { chatId, started: false, deferred: true };
      }
      return { chatId, started: deps.runs.start(chatId, options, meta), deferred: false };
    },
  };
}

/**
 * Запуск стадии ревью по ссылке (Т7): правки по замечаниям и отправка их в MR.
 *
 * Отдельно от `createSplitLauncher`, потому что момент другой: решение приходит
 * через часы после разделения, из хаба или с телефона, и «того самого» запроса с
 * его моделью и правами уже нет. Всё, что нужно, лежит в связи чата ревью, а
 * недостающее берётся из настроек панели.
 *
 * Права — `acceptEdits`, и это не вольность: человек только что нажал «исправить
 * в копии». Без них агент встал бы на первом же файле, дожидаясь у панели того,
 * кто уже ответил.
 */
export function createReviewStarter(
  ctx: ServerContext,
  deps: SplitLaunchDeps,
): (input: {
  chatId: string;
  prompt: string;
  cwd: string;
  model?: string;
  effort?: string;
  stage: 'fix' | 'push';
  fromAliases: string[];
  title?: string;
}) => boolean {
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

  return (input) => {
    // Чужой CLI сюда не попадает: связей у его разговоров нет, а значит нет и
    // карточки решения. Проверка на месте — провайдера меняют между запросами.
    if (getActiveProvider(ctx.store).id !== 'claude') return false;
    if (!input.cwd) return false;

    const settings = ctx.store.getSettings();
    activateGroupsQuietly(
      { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
      input.cwd,
      (error) => deps.log.warn({ err: error }, 'group activation failed'),
    );
    deps.runs.muteSplit(input.chatId);
    if (input.fromAliases.length > 0) deps.session.inherit(input.fromAliases, input.chatId);

    const initiative = initiativePrompt(settings, { splitMuted: true });
    const options = {
      prompt: input.prompt,
      cwd: input.cwd,
      command: activeCliCommand(ctx.store),
      model: input.model || settings.chatModel,
      effort: input.effort || settings.chatEffort,
      permissionMode: 'acceptEdits',
      permissionPrompt: { runId: input.chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
      ...(initiative ? { appendSystemPrompt: initiative } : {}),
    };
    const meta = { projectPath: input.cwd };
    // Дерево на паузе — прогон заведён, но ждёт «Продолжить всё»: решение
    // человека при этом не теряется, оно уже записано в связь.
    if (deps.gate?.defer('stage', input.chatId, options, meta)) return true;
    return deps.runs.start(input.chatId, options, meta);
  };
}

/** Запуск порции групп из записи конвейера — тем же запуском, что и у маршрута. */
export function launchFromRecord(
  ctx: ServerContext,
  deps: SplitLaunchDeps,
  record: SplitPlanRecord,
  groups: number[],
  context?: SplitGroupContext,
): Promise<TaskSplitResult> {
  const launcher = createSplitLauncher(ctx, deps, {
    projectPath: record.projectPath,
    parentChatId: record.parentChatId,
    ...(record.request.allowEdits !== undefined ? { allowEdits: record.request.allowEdits } : {}),
    ...(record.request.model ? { model: record.request.model } : {}),
    ...(record.request.effort ? { effort: record.request.effort } : {}),
    ...(record.request.assignments ? { assignments: record.request.assignments } : {}),
  });
  return launcher.launch(record.proposal, {
    startRuns: true,
    groups,
    stage: 'plan',
    ...(context ? { context } : {}),
  });
}
