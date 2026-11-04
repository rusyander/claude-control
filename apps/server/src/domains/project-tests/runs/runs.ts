import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProjectTestCase,
  ProjectTestEnvironment,
  ProjectTestGenerateMaterial,
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRun,
  ProjectTestRunRecord,
  ProjectTestRunRequest,
  ProjectTestStepResult,
} from '@agentdeck/contracts';
import { pointId, summarize as summarizeResults } from '@agentdeck/contracts/test-format';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import type { RunNotice } from '../../notify/run-notice.types.ts';
import type { CoreChatPort } from '../../chat/core-run/core-run.types.ts';
import { forgetOtherSpellings, ProjectTestsLockedError, projectEntry } from '../files.ts';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  readGroups,
  resetStatuses,
  writeGroup,
} from '../store/store.ts';
import { buildPrompt, runName, type PromptContext } from '../prompt/prompt.ts';
import { applyDraft, confineDraft, draftFile, readDraft, writeDraft } from '../drafts/drafts.ts';
import { stampOf } from '../generate-sources/generate-sources.ts';
import { redactor } from '../env-secrets/env-secrets.ts';
import { defaultEnvironment, readEnvironments, readSharedSteps } from '../library/library.ts';
import { planCases, readPlan } from '../plans/plans.ts';
import { gitContext, impactOf, releaseTag } from '../impact/impact.ts';
import { writeRun } from '../runs-store/runs-store.ts';
import { contentStamps, stampInputs, stampsOf } from '../content-stamp/content-stamp.ts';
import {
  runScope,
  scopeClause,
  scopeSession,
  type RunScope,
} from '../run-permissions/run-permissions.ts';
import { auditScope, scopeBaseline, type ScopeBaseline } from '../run-permissions/scope-audit.ts';
import { coded } from '../../../lib/server-text/server-text.ts';
import { e2eFolderView } from '../e2e-folder/e2e-folder.ts';
import { e2eCommand, shellLine } from '../e2e-command/e2e-command.ts';
import { E2E_JUNIT_REPORT } from '../e2e-scaffold.ts';
import { syncE2eFolder } from '../e2e-sync/e2e-sync.ts';
import { importResultsIntoRun } from '../import-results/import-results.ts';
import type { TestsAgentEvent } from '../agent/agent-run.types.ts';
import { defaultTestsCorePort, type TestsAgentProvider } from '../agent/agent-runs.ts';
import {
  TESTS_CORE_ORPHAN_REASON,
  TestsCoreRun,
  taskEnvOf,
  type TestsCoreStart,
} from '../agent/core-run.ts';
import { reapPanelAgentOrphans, type ReapDeps } from '../../panel-agent/processes/processes.ts';
import type { CarryOutcome } from '../../chat/core-run/session-carry.ts';

/**
 * Журнал процессов агентских прогонов прежней панели (до этапа 10). Теперь CLI прогона — потомок
 * хоста сеанса ядра, и его жизнь ведёт ядро (сверка процессов на своём старте); панель в журнал
 * больше не пишет, но старт снимает то, что в нём осталось от панели прежней версии.
 */
export const PROJECT_TEST_PROCESS_LEDGER = 'project-test-runs.json';

/**
 * Журнал раннеров «Прогнать автотесты» (`e2e-run.ts`, F-105). Раннер идёт через
 * оболочку и жёсткое убийство панели переживает: Playwright с браузерами висел
 * сиротой и дописывал отчёт туда, откуда читает следующий прогон. Свой файл —
 * записи раннера не смешиваются с CLI агентских прогонов.
 */
export const E2E_RUN_PROCESS_LEDGER = 'e2e-runs.json';
/**
 * Журнал процессов проверки поломкой (Ф11): по нему dev-сторож ждёт её конца, а
 * старт панели снимает сирот, переживших её падение.
 */
export const MUTATION_PROCESS_LEDGER = 'mutation-runs.json';

/**
 * Старт панели: снять дерево каждого живого процесса прогонов тестов из обоих
 * журналов — CLI агентского прогона и раннера автотестов. Сколько убито.
 */
export function reapProjectTestOrphans(appData: string, deps: ReapDeps = {}): number {
  return (
    reapPanelAgentOrphans(appData, deps, PROJECT_TEST_PROCESS_LEDGER) +
    reapPanelAgentOrphans(appData, deps, E2E_RUN_PROCESS_LEDGER) +
    reapPanelAgentOrphans(appData, deps, MUTATION_PROCESS_LEDGER)
  );
}

/**
 * Прогоны тестов: генерация кейсов, их проверка, свободный поиск, автоматизация.
 *
 * Отдельный реестр, а не ветка чата, — намеренно. Прогон длинный и шумный:
 * сотня кейсов — это тысячи вызовов инструментов, и в ленте разговора после
 * такого не найти ни одного человеческого сообщения. Здесь он идёт своей
 * сессией, а панель показывает результат списком галочек.
 *
 * Прогресс панель берёт НЕ отсюда: статусы пишет сам агент в файлы кейсов, и
 * клиент перечитывает их, пока прогон идёт. Дублировать это состояние в памяти
 * значило бы завести второй источник правды, который разъедется с первым.
 * Поэтому и запись в историю собирается ИЗ ФАЙЛОВ на финише: что агент успел
 * записать, то в истории и окажется — включая оборванный прогон.
 *
 * Реестр живёт дольше запроса, поэтому создаётся в `bootstrap/runtime/runtime.ts` —
 * только оттуда прогоны можно погасить при выходе панели.
 */

/** Хвост лога: полный вывод агента за сотню кейсов — это мегабайты. */
const MAX_LOG = 200_000;

/**
 * Откуда прогон берёт доступы стенда. Считает их МАРШРУТ: домен не знает ни про
 * appData панели, ни про шифрование, и обязан запускаться на голом каталоге —
 * ровно так же, как отчёт считается без сети.
 */
export type RunSecretsResolver = (environment?: ProjectTestEnvironment) => {
  values: Record<string, string>;
  missing: { name: string; title?: string }[];
};

/** Одновременно идущий прогон на проект — один. */
export class ProjectTestRunRegistry {
  private readonly runs = new Map<
    string,
    {
      view: ProjectTestRun;
      run: TestsCoreRun;
      /** Границы прогона и состояние рабочего дерева на старте — для сверки на финише. */
      audit?: { scope: RunScope; baseline: ScopeBaseline };
      /** Принимать черновик генерации без просмотра — решение человека на старте. */
      autoAccept?: boolean;
      /** Затирание доступов стенда во всём, что выходит наружу. */
      redact?: (text: string) => string;
      /** Отпечатки кейсов отбора на старте — по ним видно, что агент тронул. */
      snapshot?: Map<string, string>;
      /**
       * Отпечатки содержимого кейсов отбора на старте (`groupId:caseId` → хеш) —
       * в запись прогона, как у `tests-cli run`: ворота судят свежесть по ним, а
       * не по времени. Кейса нет — нет `codePaths` или предел: правило времени.
       */
      stamps?: Map<string, string>;
      /** Папка e2e генерации с кодом тестов: после конца — сверка и отчёт junit. */
      e2e?: { dir: string; junit: string };
    }
  >();

  /**
   * Порт ядра: прогон идёт задачей ядра (`agent/core-run.ts`). По умолчанию — запись ядра в его
   * доме; тесты подставляют управляемое ядро.
   */
  private corePort: () => CoreChatPort = (() => {
    let port: CoreChatPort | undefined;
    return () => (port ??= defaultTestsCorePort());
  })();

  setCorePort(port: CoreChatPort): void {
    this.corePort = () => port;
  }

  /**
   * Снять задачу ядра прогона, пережившего прошлую жизнь панели. Без ответа: ядро не
   * поднято или задача уже кончилась — снимать нечего, а чтение раздела ждать не должно.
   */
  cancelOrphanCoreTask(taskId: string): void {
    void this.corePort()
      .command(taskId, 'cancel', { reason: TESTS_CORE_ORPHAN_REASON })
      .catch(() => undefined);
  }

  /**
   * Куда сообщить, что прогон кончился. Тот же отправитель, что у чатов:
   * регресс сотни кейсов идёт десятки минут, и человек всё это время не сидит
   * перед панелью. Наружу уходит только вид события и имя папки проекта.
   */
  private notify?: (notice: RunNotice) => void;

  setNotifier(notify: (notice: RunNotice) => void): void {
    this.notify = notify;
  }

  /** Язык панели: на нём имя сессии прогона в списке разговоров. */
  private language: () => 'ru' | 'en' = () => 'ru';

  setLanguage(language: () => 'ru' | 'en'): void {
    this.language = language;
  }

  /**
   * Слой панели агенту тестов на Claude (этап 10, G13): флаги наших слоёв и набор, которые прежний
   * прогон брал из маршрута `tests` (`carryOfTestsRoute`). Спрашивается на КАЖДОМ старте: снятая
   * галочка или сменённый режим набора действуют со следующего прогона. Чужие CLI прежде слоя не
   * получали — не получают и сейчас. Нет решателя — прогон без слоя (тесты домена).
   */
  private layerCarry?: () => CarryOutcome;

  setLayerCarry(resolve: () => CarryOutcome): void {
    this.layerCarry = resolve;
  }

  /** Прогон проекта: идущий или последний завершившийся. */
  get(projectPath: string): ProjectTestRun | undefined {
    return projectEntry(this.runs, projectPath)?.view;
  }

  /** Все прогоны — по ним панель узнаёт, что где-то ещё идёт работа. */
  list(): ProjectTestRun[] {
    return [...this.runs.values()].map((entry) => entry.view);
  }

  /**
   * Прогон, который держит эту группу прямо сейчас, — его id или ничего.
   *
   * Пока агент идёт по кейсам, он переписывает файл группы после КАЖДОГО из них.
   * Правка из панели в этот момент либо потеряется под его записью, либо сотрёт
   * его результаты: обе стороны честно пишут файл целиком. Поэтому на время
   * прогона группа занята, а человек получает 409 с именем прогона — его видно
   * в панели и его можно остановить.
   *
   * Прогон без группы (`groupId` пуст) идёт по всем файлам сразу и держит любую.
   */
  holds(projectPath: string, groupId?: string): string | undefined {
    const entry = projectEntry(this.runs, projectPath);
    if (!entry || entry.view.status !== 'running') return undefined;
    if (entry.view.groupId && groupId && entry.view.groupId !== groupId) return undefined;
    return entry.view.id;
  }

  /**
   * Запустить прогон. Возвращает управление сразу: агент работает в фоне, а
   * клиент видит его по `GET /api/project-tests`.
   */
  start(
    request: ProjectTestRunRequest,
    now: string,
    material?: ProjectTestGenerateMaterial,
    resolveSecrets?: RunSecretsResolver,
    /**
     * `appData` — каталог данных панели: в нём выбор папки e2e человеком
     * (монорепозиторий). Без него генерация брала первую найденную папку, а
     * карточка, заметка чата и кнопка прогона — выбранную.
     *
     * `ensureE2e` — завести папку e2e (пишет маршрут: домен про запись панели не
     * знает). Зовётся ПОСЛЕ всех отказов старта: отказанный прогон («уже идёт»,
     * «кейсов нет») папку на диске не оставляет.
     *
     * `routes` — маршрут контура, когда у активного контура включена галочка «tests»
     * (`coreContourRoutes`): разрешённый набор задачи ядра. Нет — набор ядра по умолчанию.
     */
    options: {
      appData?: string;
      ensureE2e?: () => void;
      provider?: TestsAgentProvider;
      routes?: TestsCoreStart['routes'];
    } = {},
  ): ProjectTestRun {
    const provider: TestsAgentProvider = options.provider ?? { id: 'claude', name: 'Claude Code' };
    const root = request.projectPath;
    if (!existsSync(root))
      throw coded(new ProjectTestsError('Каталог проекта не найден.'), 'project-dir-not-found');

    const active = projectEntry(this.runs, root);
    // Занято — конфликт (409) с id идущего прогона, как у замка группы, а не
    // 400 «кривой запрос»: клиент по коду понимает «уже идёт» и может его открыть.
    if (active?.view.status === 'running') {
      throw coded(
        new ProjectTestsLockedError('Прогон по этому проекту уже идёт.', active.view.id),
        'run-already-running',
      );
    }

    const all = readGroups(root);
    const scoped = request.groupId ? all.filter((group) => group.id === request.groupId) : all;
    if (request.groupId && scoped.length === 0) {
      throw coded(
        new ProjectTestsNotFoundError(`Группы «${request.groupId}» в проекте нет.`),
        'run-group-not-found',
        { groupId: request.groupId },
      );
    }
    const caseIds = this.pickCases(root, all, request);

    // Исследование без хартии — это блуждание: агент час ходит по приложению и
    // приносит десяток кейсов ни о чём. Хартию задаёт то же поле пожелания, и
    // отказ здесь дешевле такого прогона.
    if (request.mode === 'explore' && !request.scope?.trim()) {
      throw coded(
        new ProjectTestsError(
          'Исследование идёт по хартии: напишите в поле пожелания, что именно смотреть ' +
            '(«вложения в чате», «права на страницах проекта»).',
        ),
        'run-explore-charter-required',
      );
    }

    if (request.mode === 'run' || request.mode === 'automate') {
      if (scoped.length === 0)
        throw coded(new ProjectTestsError('Прогонять нечего: кейсов нет.'), 'run-no-cases');
      const broken = scoped.find((group) => group.error);
      if (broken)
        throw coded(
          new ProjectTestsError(`Группа «${broken.id}»: ${broken.error}`),
          'run-group-broken',
          { groupId: broken.id, reason: broken.error ?? '' },
        );
      if (caseIds && caseIds.length === 0) {
        throw coded(
          new ProjectTestsError(
            request.changedOnly
              ? 'Правки рабочей копии не задели ни одного кейса.'
              : 'Прогонять нечего: под отбор не попал ни один кейс.',
          ),
          request.changedOnly ? 'run-changed-none' : 'run-selection-empty',
        );
      }
    }

    // Автоматизировать уже автоматизированное значит переписать работающие
    // тесты заново. Кейс с `automated` задание и так велит пропускать — но
    // прогон, у которого таких кейсов ВСЕ, запускать незачем.
    if (request.mode === 'automate' && !hasWorkToAutomate(scoped, caseIds)) {
      throw coded(
        new ProjectTestsError('Автоматизировать нечего: кейсы отбора уже помечены automated.'),
        'run-automate-nothing',
      );
    }

    if (request.mode === 'run' && request.full) {
      for (const group of scoped) resetStatuses(root, group.id, caseIds);
    }

    const environments = readEnvironments(root);
    const environmentId = pickEnvironmentId(
      environments,
      request.environmentId,
      request.planId ? readPlan(root, request.planId)?.environmentIds?.[0] : undefined,
    );
    const { branch, commit } = gitContext(root);
    // Генерация с кодом тестов: папку заводит маршрут, здесь её только находим —
    // домен считается на голом каталоге и про запись панели не знает.
    if (request.mode === 'generate' && request.e2e) options.ensureE2e?.();
    const folder =
      request.mode === 'generate' && request.e2e ? e2eFolderView(root, options.appData) : undefined;
    // Команда прогона — та же, что у кнопки «Прогнать автотесты», с отчётом туда,
    // откуда его заберёт `settleE2e`: путь абсолютный, иначе Playwright разрешал
    // его от каталога конфига и писал в e2e/e2e/results — мимо панели.
    // Имя отчёта — своё у прогона: копии проекта делят папку e2e оригинала
    // ссылкой, и две генерации в двух копиях писали один `results/junit.xml`,
    // ставя кейсам результаты соседа (F-316).
    const runId = randomUUID();
    const junit = runReportName(runId);
    const command = folder?.dir && e2eCommand(root, folder, join(root, folder.dir, junit));
    const e2e = folder?.dir
      ? {
          dir: folder.dir,
          framework: folder.framework,
          junit,
          ...(command ? { command: shellLine(command) } : {}),
        }
      : undefined;
    // Веху называет человек, а если не назвал — берём метку git: релиз,
    // помеченный тегом, отчёт узнаёт сам, и просить об этом ещё раз незачем.
    const release = request.release?.trim() || releaseTag(root);

    const view: ProjectTestRun = {
      id: runId,
      projectPath: root,
      mode: request.mode,
      actor: 'agent',
      groupId: request.groupId,
      caseIds,
      planId: request.planId,
      environmentId,
      branch,
      commit,
      scope: request.scope,
      release,
      status: 'running',
      startedAt: now,
      log: '',
      tokens: 0,
      costUsd: 0,
      // Кем шёл прогон: у чужого CLI нет сессии, и открыть его в чате нечем.
      provider: provider.id,
      // След источника едет в запись прогона: черновик применяют позже, иногда
      // через день, и к тому времени материал взять уже неоткуда.
      generate: stampOf(material),
    };

    // Кейсы читаем ПОСЛЕ возможного сброса статусов: иначе в задание уехали бы
    // галочки прошлого прогона, которые человек только что попросил забыть.
    const groups = request.full ? readGroups(root) : all;
    const environment = environments.find((item) => item.id === environmentId);
    // Доступы стенда: значения уедут окружением задачи ядра (переменные процесса CLI), а в
    // задании агент увидит только их ИМЕНА — прочитать их он может сам.
    const secrets = resolveSecrets?.(environment) ?? { values: {}, missing: [] };
    const context: PromptContext = {
      shared: readSharedSteps(root),
      environment,
      impact: request.changedOnly ? impactOf(root, groups).cases : undefined,
      // Имя файла черновика содержит id прогона: сам его агент не выдумает, а
      // две генерации подряд не должны писать в один файл. Прогон получает его
      // ради шага 8: недостающая проверка идёт предложением, а не записью в группу.
      draftFile:
        request.mode === 'generate' || request.mode === 'run' ? draftFile(view.id) : undefined,
      // Материал источника собирает маршрут: он умеет ходить в трекер, а
      // реестр — нет, и тянуть сюда сеть значило бы сделать старт прогона
      // зависящим от чужой системы.
      material,
      e2e,
    };
    const prompt = buildPrompt(
      request.groupId ? groups.filter((group) => group.id === request.groupId) : groups,
      { ...request, caseIds },
      context,
    );

    const run = new TestsCoreRun({
      port: this.corePort(),
      onDeny: (tool, message) => this.note(root, tool, message),
    });
    // Автоматизации — папка e2e проекта (своя или заведённая панелью): первый
    // спек кейса без `automation.file` иначе писать было бы некуда (живая проверка 08.10).
    const automateDir =
      request.mode === 'automate' ? e2eFolderView(root, options.appData).dir : undefined;
    const scope = runScope(
      root,
      request.mode,
      scoped.flatMap((group) => group.cases),
      e2e?.dir ?? automateDir,
    );
    forgetOtherSpellings(this.runs, root);
    this.runs.set(root, {
      view,
      run,
      // Решение владельца: генерация с кодом тестов идёт до конца сама — черновик
      // применяется, откат остаётся в истории черновиков.
      autoAccept: request.autoAccept === true || e2e !== undefined,
      ...(e2e ? { e2e: { dir: e2e.dir, junit: e2e.junit } } : {}),
      redact: redactor(secrets.values),
      snapshot: fingerprintCases(groups, view),
      ...(recordsResults(request.mode)
        ? { stamps: startStamps(root, groups, request.groupId, caseIds) }
        : {}),
      audit: { scope, baseline: scopeBaseline(root) },
    });
    // Нехватка доступа прогон не отменяет, но молчать о ней нельзя: провал
    // входа иначе выглядит как поломка приложения.
    for (const ref of secrets.missing) {
      this.note(
        root,
        'окружение',
        `значения переменной ${ref.name} на этой машине нет${ref.title ? ` (${ref.title})` : ''} — ` +
          'заполните её в доступах окружения, иначе вход в стенд не выполнится',
      );
    }
    // Доступы стенда — окружение задачи ядра: имена в журнал задачи, значения только в память
    // ядра до конца задачи. Имя, которое ядро отказало бы (своё ядра, негодное, сверх потолка),
    // называется здесь, а не роняет оценку целиком.
    // Слой панели (G13) — только Claude, как прежде; его переменные занимают места в потолке ядра.
    const layer = provider.id === 'claude' ? this.layerCarry?.() : undefined;
    const layerEnv = layer?.ok ? layer.carry.env : {};
    const taskEnv = taskEnvOf(secrets.values, Object.keys(layerEnv).length);
    for (const name of taskEnv.dropped) {
      this.note(
        root,
        'окружение',
        `переменная ${name} в прогон не передана: ядро такое имя окружения задаче не даёт — ` +
          'вход в стенд с ней не выполнится',
      );
    }
    if (request.e2e && !e2e) {
      this.note(root, 'e2e', 'папки e2e в проекте нет — генерация напишет только кейсы');
    }
    this.persist(root, view, this.runs.get(root)?.stamps);

    const name = runName(request, scoped, this.language());
    // Границы режима держит судья ядра (`session.scope`); в задании они же словами — модель
    // держит правило, о котором знает, — а сверка на финише ловит правку командой оболочки.
    // Слой — полями сеанса рядом с границами; имена его переменных `sessionOf` берёт из `env`.
    const { env: _layerNames, ...layerSession } = layer?.ok ? layer.carry.session : {};
    const env = { ...taskEnv.env, ...layerEnv };
    void this.launch(
      root,
      run,
      provider,
      `${prompt}\n\n${scopeClause(scope)}`,
      name,
      {
        session: { ...layerSession, scope: scopeSession(scope) },
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(options.routes?.length ? { routes: options.routes } : {}),
      },
      layer && !layer.ok ? layer.reason : undefined,
    );

    return view;
  }

  /**
   * Запуск прогона задачей ядра. Права решает судья ядра: правка — только в корне проекта (без
   * `.git`, настроек CLI и дорог публикации) и только в границах режима (`session.scope`), команды
   * git, двигающие историю, — отказ; вопрос права, поднятый ядром, получает отказ за отсутствующего
   * человека (`core-run.ts`). Сверка на финише (`scope-audit.ts`) ловит файлы, тронутые оболочкой.
   */
  private async launch(
    root: string,
    run: TestsCoreRun,
    provider: TestsAgentProvider,
    prompt: string,
    name: string,
    extra: Pick<TestsCoreStart, 'session' | 'env' | 'routes'>,
    /** Слой панели не переносится в сеанс ядра — прогон не идёт, причина в его итоге (как прежде). */
    layerRefusal?: string,
  ): Promise<void> {
    // Вид прогона уходит клиенту раньше первого события: старт дописывает заметки и сохраняет вид
    // синхронно, а событие до этого закрыло бы прогон посреди записи. «Стоп» в эту паузу — ядро
    // не зовём вовсе: задачи ещё нет, снимать нечего.
    await Promise.resolve();
    const current = this.runs.get(root);
    if (current?.run !== run || current.view.status !== 'running') return;
    if (layerRefusal !== undefined) {
      this.finish(root, 'error', layerRefusal);
      return;
    }
    try {
      await run.start(
        {
          adapter: provider.id,
          providerName: provider.name,
          prompt,
          cwd: root,
          title: name,
          lang: this.language(),
          ...extra,
        },
        (event) => this.consume(root, event),
      );
      // Ход кончился без итога (ядро закрыло сеанс молча) — прогон не висит «идёт».
      const entry = this.runs.get(root);
      if (entry?.run === run && entry.view.status === 'running') {
        this.finish(root, 'error', 'Ядро закончило прогон без итога.');
      }
    } catch (error) {
      this.finish(root, 'error', (error as Error).message);
    }
  }

  /** Сверка границ прогона на финише (`scope-audit.ts`) — строками в лог. */
  private noteAudit(root: string, audit: { scope: RunScope; baseline: ScopeBaseline }): void {
    const found = auditScope(root, audit.scope, audit.baseline);
    if (found.skipped) {
      this.note(root, 'границы', `сверка рабочего дерева не выполнена: ${found.skipped}`);
      return;
    }
    if (found.total > 0) {
      const more =
        found.total > found.outside.length ? ` и ещё ${found.total - found.outside.length}` : '';
      this.note(
        root,
        'границы',
        `за прогон тронуты файлы вне границ режима: ${found.outside.join(', ')}${more} — проверьте дифф`,
      );
    }
    if (found.headMoved) {
      this.note(
        root,
        'границы',
        'за прогон сдвинулась голова ветки (коммит, сброс или переключение)',
      );
    }
  }

  /** Строка от панели в лог прогона — отказ прав или причина, почему их нет. */
  private note(projectPath: string, tool: string, message: string): void {
    const entry = this.runs.get(projectPath);
    if (!entry) return;
    const clean = entry.redact ? entry.redact(message) : message;
    entry.view.log = tail(`${entry.view.log}\n· панель: ${tool} — ${clean}\n`);
  }

  /** Остановить прогон человеком. Уже записанные статусы остаются. */
  stop(projectPath: string): boolean {
    const entry = this.runs.get(projectPath);
    if (!entry || entry.view.status !== 'running') return false;
    entry.run.stop();
    this.finish(projectPath, 'stopped');
    return true;
  }

  /** Погасить все прогоны — вызывается при выходе сервера панели. */
  stopAll(): void {
    for (const [path, entry] of this.runs) {
      if (entry.view.status === 'running') {
        entry.run.stop();
        this.finish(path, 'stopped');
      }
    }
  }

  /**
   * Какие кейсы гнать: план, ручной отбор или пересечение с правками.
   *
   * `undefined` значит «всё, что в области» — это не то же самое, что пустой
   * список: пустой означает, что отбор ничего не нашёл, и прогон запускать
   * незачем.
   */
  private pickCases(
    root: string,
    groups: ProjectTestGroup[],
    request: ProjectTestRunRequest,
  ): string[] | undefined {
    let ids = request.caseIds?.length ? [...request.caseIds] : undefined;

    // Отбор по id проверяется ДО старта: раньше прогон с опечаткой в id
    // стартовал, час работал по пустому отбору и заканчивался «нечего». Здесь же
    // принимается и форма «группа:кейс» — та, что у планов и ручного прохода.
    if (ids) {
      const scoped = request.groupId ? groups.filter((g) => g.id === request.groupId) : groups;
      const known = new Map<string, string>();
      for (const group of scoped) {
        for (const item of group.cases) {
          known.set(item.id, item.id);
          known.set(`${group.id}:${item.id}`, item.id);
        }
      }
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw coded(
          new ProjectTestsError(
            `Кейсов «${missing.slice(0, 5).join('», «')}» в отборе нет — проверьте id.`,
          ),
          'run-cases-missing',
          { ids: missing.slice(0, 5).join('», «') },
        );
      }
      ids = [...new Set(ids.map((id) => known.get(id) as string))];
    }

    if (request.planId) {
      const plan = readPlan(root, request.planId);
      if (!plan)
        throw coded(
          new ProjectTestsNotFoundError(`Плана «${request.planId}» в проекте нет.`),
          'run-plan-not-found',
          { planId: request.planId },
        );
      const fromPlan = planCases(groups, plan).map((item) => item.testCase.id);
      ids = ids ? ids.filter((id) => fromPlan.includes(id)) : fromPlan;
    }

    if (request.changedOnly) {
      const touched = impactOf(root, groups).cases.map((item) => item.caseId);
      ids = ids ? ids.filter((id) => touched.includes(id)) : touched;
    }

    return ids;
  }

  /** События агента → лог и расход. Статусы кейсов пишет он сам, мимо панели. */
  private consume(projectPath: string, event: TestsAgentEvent): void {
    const entry = this.runs.get(projectPath);
    if (!entry) return;
    const view = entry.view;

    // Агент читает пароль из своего окружения и может повторить его в выводе —
    // например, показав команду входа целиком. В лог он попадать не должен: лог
    // видит человек, он же уезжает на телефон уведомлением.
    const hide = entry.redact ?? ((value: string) => value);

    if (event.kind === 'session') {
      view.sessionId = event.sessionId;
      // Задача ядра — сразу в запись на диске: панель, перезапущенная посреди прогона,
      // снимает по ней задачу, которая иначе работала бы дальше без хозяина.
      const coreTaskId = entry.run.taskId();
      if (coreTaskId && view.coreTaskId !== coreTaskId) {
        view.coreTaskId = coreTaskId;
        this.persist(projectPath, view, entry.stamps);
      }
    }
    if (event.kind === 'text') view.log = tail(view.log + hide(event.text));
    if (event.kind === 'tool') {
      view.log = tail(`${view.log}\n· ${event.name} ${hide(firstArg(event.input))}\n`);
    }
    if (event.kind === 'usage') {
      view.tokens += event.input + event.output + event.cacheRead + event.cacheCreation;
      view.costUsd += event.costUsd ?? 0;
    }
    if (event.kind === 'done') {
      view.sessionId = event.sessionId || view.sessionId;
      this.finish(projectPath, 'done');
    }
    if (event.kind === 'error') {
      this.finish(
        projectPath,
        'error',
        event.message,
        event.messageCode ? { messageCode: event.messageCode, params: event.params } : undefined,
      );
    }
  }

  private finish(
    projectPath: string,
    status: ProjectTestRun['status'],
    error?: string,
    /** Код текста ошибки — отказ проверки прав человек читает на своём языке. */
    code?: { messageCode: ServerMessageCode; params?: ServerMessageParams },
  ): void {
    const entry = this.runs.get(projectPath);
    if (!entry || entry.view.status !== 'running') return;
    // Границы режима — по факту дерева, ДО записей самой панели (черновик, сверка e2e).
    if (entry.audit) this.noteAudit(projectPath, entry.audit);
    entry.view.status = status;
    entry.view.finishedAt = new Date().toISOString();
    if (error) entry.view.error = entry.redact ? entry.redact(error) : error;
    if (error && code) {
      entry.view.messageCode = code.messageCode;
      if (code.params) entry.view.params = code.params;
    }
    // Заметки к кейсам пишет агент, а они уезжают в историю прогонов — файл в
    // git проверяемого проекта. Секрет, попавший в «не пустил с паролем …»,
    // остался бы там навсегда.
    if (recordsResults(entry.view.mode)) {
      stampRunResults(projectPath, entry.view, entry.snapshot ?? new Map(), entry.view.finishedAt);
    }
    entry.view.results = collectResults(projectPath, entry.view, entry.redact);
    entry.view.summary = summarizeResults(entry.view.results);
    if (entry.view.mode === 'generate' || entry.view.mode === 'run') {
      this.settleDraft(projectPath, entry.view, entry.autoAccept === true);
    }
    if (entry.e2e && status === 'done') this.settleE2e(projectPath, entry.view, entry.e2e);
    this.persist(projectPath, entry.view, entry.stamps);
    // Об остановке рукой сообщать незачем: её сделал тот же человек, который
    // сейчас смотрит на панель.
    if (status !== 'stopped') {
      // Ключом идёт сессия CLI: прогон — это обычный разговор, и по нажатию на
      // уведомление телефон открывает именно его, а не пустой экран.
      this.notify?.({
        kind: status === 'error' ? 'error' : 'done',
        chatId: entry.view.sessionId ?? entry.view.id,
        projectPath,
        // Сколько шёл прогон: «Закончил» в Telegram — только после долгой работы.
        durationMs: Math.max(0, Date.now() - Date.parse(entry.view.startedAt)),
      });
    }
  }

  /**
   * Что делать с черновиком, который оставила генерация — или прогон, заметивший
   * недостающую проверку (шаг 8 задания).
   *
   * Прогон писать в библиотеку не может — прав нет, — поэтому здесь либо
   * применение по галочке, либо ничего: черновик остаётся ждать человека. И то
   * и другое видно строкой в логе прогона, а счёт — записью в истории: вопрос
   * «откуда в наборе взялись эти кейсы» задают через месяц, когда черновик уже
   * в архиве.
   */
  private settleDraft(root: string, view: ProjectTestRun, auto: boolean): void {
    const found = readDraft(root, view.id);
    if (!found) return;
    // Время черновика — панели: агент пишет его сам и ошибается на часы и сутки
    // (живой прогон 26.09 — полдень завтрашнего дня), а по нему черновики
    // сортируются, и выдуманное будущее заслоняло бы всё, что придёт после.
    const at = view.finishedAt ?? new Date().toISOString();
    const written = found.error || found.createdAt === at ? found : { ...found, createdAt: at };
    if (written !== found) writeDraft(root, written);
    // Группу выбрал человек; агент её советом считает, панель — правилом.
    const draft = confineDraft(root, written, view.groupId);
    if (draft.error) {
      this.note(root, 'черновик', draft.error);
      return;
    }
    // Отброшенные правки — строкой лога: при автоприёмке черновик человек не
    // открывает, и причина иначе осталась бы только в файле.
    for (const warning of draft.warnings ?? []) this.note(root, 'черновик', warning);

    let accepted = 0;
    if (auto) {
      try {
        const result = applyDraft(root, view.id, {
          auto: true,
          now: new Date().toISOString(),
          stamp: view.generate,
        });
        accepted = result.applied;
        this.note(root, 'черновик', `принято автоматически, ${accepted} кейсов`);
        for (const item of result.skipped) {
          this.note(root, 'черновик', `${item.caseId} не принят: ${item.reason}`);
        }
      } catch (failure) {
        this.note(root, 'черновик', `не применился: ${(failure as Error).message}`);
      }
    } else if (draft.items.length > 0) {
      this.note(root, 'черновик', `${draft.items.length} правок ждут приёмки`);
    }

    view.draft = { runId: view.id, proposed: draft.items.length, accepted, auto };
  }

  /**
   * Конец генерации с кодом тестов: тесты папки — в кейсы, отчёт junit — в
   * результаты. ПОСЛЕ черновика: кейсы с метками `[id]` к этому моменту уже в
   * группах, и сверка находит их по метке, а не заводит дубли.
   *
   * Отчёт берётся, только если он свежее старта прогона: старый файл от прошлого
   * запуска выдал бы чужие результаты за результаты этого.
   */
  private settleE2e(root: string, view: ProjectTestRun, e2e: { dir: string; junit: string }): void {
    try {
      const sync = syncE2eFolder(root, new Date().toISOString(), { dir: e2e.dir });
      this.note(
        root,
        'e2e',
        `сверка папки ${e2e.dir}: файлов ${sync.files}, тестов ${sync.tests}, новых кейсов ` +
          `${sync.added}, привязано ${sync.linked}`,
      );
    } catch (failure) {
      this.note(root, 'e2e', `сверка папки не удалась: ${(failure as Error).message}`);
      return;
    }
    const report = `${e2e.dir}/${e2e.junit}`;
    let fresh = false;
    try {
      fresh = statSync(join(root, report)).mtimeMs >= Date.parse(view.startedAt) - 1000;
    } catch {
      // Отчёта нет — тесты не запускались.
    }
    if (!fresh) {
      this.note(root, 'e2e', `свежего отчёта ${report} нет — результаты не проставлены`);
      return;
    }
    try {
      // Результаты — строкой ЭТОЙ генерации: отдельная запись «импорт» делала из
      // одного запуска две строки истории, и итог генерации читался пустым.
      const { result: imported, points } = importResultsIntoRun(
        root,
        { format: 'junit', file: report, environmentId: view.environmentId },
        view.id,
      );
      view.results = points;
      view.summary = summarizeResults(points);
      this.note(
        root,
        'e2e',
        `отчёт ${report}: результатов ${imported.read}, легло на кейсы ${imported.matched}` +
          (imported.unmatched.length > 0 ? `, без кейса ${imported.unmatched.length}` : ''),
      );
    } catch (failure) {
      this.note(root, 'e2e', `отчёт не разобран: ${(failure as Error).message}`);
    }
    // Результаты уже в истории; отчёт со своим именем у каждого прогона иначе
    // копился бы в папке без конца.
    rmSync(join(root, report), { force: true });
  }

  /** Прогон в историю — той же формой, что и ручной. */
  private persist(
    projectPath: string,
    view: ProjectTestRun,
    stamps?: ReadonlyMap<string, string>,
  ): void {
    const record: ProjectTestRunRecord = {
      id: view.id,
      mode: view.mode,
      actor: 'agent',
      groupId: view.groupId,
      planId: view.planId,
      environmentId: view.environmentId,
      branch: view.branch,
      commit: view.commit,
      scope: view.scope,
      release: view.release,
      status: view.status,
      startedAt: view.startedAt,
      finishedAt: view.finishedAt,
      error: view.error,
      messageCode: view.messageCode,
      params: view.params,
      provider: view.provider,
      tokens: view.tokens,
      costUsd: view.costUsd,
      sessionId: view.sessionId,
      ...(view.coreTaskId ? { coreTaskId: view.coreTaskId } : {}),
      results: view.results ?? [],
      summary: view.summary ?? summarizeResults(view.results ?? []),
      draft: view.draft,
      generate: view.generate,
      ...stampsOf(stamps, view.results ?? []),
    };
    try {
      writeRun(projectPath, record);
    } catch {
      // История прогонов — удобство, а не результат: если каталог проекта стал
      // недоступен для записи, терять из-за этого сам прогон нельзя.
    }
  }
}

/**
 * Окружение прогона: названное человеком, иначе первое из плана, иначе то, что
 * помечено по умолчанию.
 *
 * Последнее звено раньше отсутствовало, и это молча ломало ровно тот случай,
 * ради которого окружение и заводят: пульт с выбором «по умолчанию» не слал
 * ничего, и прогон шёл без адреса стенда — а с Т12 не получил бы и доступов к
 * нему. Ручной прогон и планы подставляли умолчание всегда; агентский прогон
 * оставался единственным местом, где оно не работало.
 */
export function pickEnvironmentId(
  environments: ProjectTestEnvironment[],
  explicit?: string,
  fromPlan?: string,
): string | undefined {
  return explicit ?? fromPlan ?? defaultEnvironment(environments)?.id;
}

/**
 * Есть ли в отборе хоть один кейс, который ещё не в коде.
 *
 * Считается по тем же кейсам, что уедут в задание: панель показывает это число
 * на кнопке, и отказ обязан совпадать с тем, что человек видел до нажатия.
 */
function hasWorkToAutomate(groups: ProjectTestGroup[], caseIds?: string[]): boolean {
  return groups.some((group) =>
    group.cases.some(
      (item) =>
        (!caseIds?.length || caseIds.includes(item.id)) &&
        !item.archived &&
        item.automation?.status !== 'automated',
    ),
  );
}

/** Кейсы отбора прогона — по ним снимается отпечаток и ставится штамп. */
function scopedCases(
  groups: ProjectTestGroup[],
  view: Pick<ProjectTestRun, 'groupId' | 'caseIds'>,
): { group: ProjectTestGroup; testCase: ProjectTestCase }[] {
  const picked: { group: ProjectTestGroup; testCase: ProjectTestCase }[] = [];
  for (const group of groups) {
    if (group.error) continue;
    if (view.groupId && group.id !== view.groupId) continue;
    for (const testCase of group.cases) {
      if (view.caseIds?.length && !view.caseIds.includes(testCase.id)) continue;
      picked.push({ group, testCase });
    }
  }
  return picked;
}

/** То в кейсе, что пишет прогон, одной строкой: изменилось — значит, агент тронул. */
function fingerprint(testCase: ProjectTestCase): string {
  return JSON.stringify([
    testCase.status,
    testCase.statusId,
    testCase.note,
    testCase.lastRunAt,
    testCase.failure,
    testCase.attachments,
  ]);
}

export function fingerprintCases(
  groups: ProjectTestGroup[],
  view: Pick<ProjectTestRun, 'groupId' | 'caseIds'>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const { group, testCase } of scopedCases(groups, view)) {
    map.set(`${group.id}:${testCase.id}`, fingerprint(testCase));
  }
  return map;
}

/** Секунда запаса на часы: штамп агента чуть позже `finishedAt` — ещё не будущее. */
const CLOCK_SLACK_MS = 60_000;

/**
 * Штамп прогона на том, что агент тронул.
 *
 * Кейс, который прогон изменил (статус, заметка, разбор, время), получает
 * `lastRunId` этого прогона, а его `lastRunAt` втискивается в границы прогона.
 * Без этого история верила времени, которое написал агент, — а он пишет
 * местное время с буквой Z, и «19:24Z» при реальных 14:24Z делает результат
 * будущим: следующая генерация через час собирала его в СВОЮ запись, а отчёт
 * читал «гоняли сегодня» у кейса, который трогали вчера.
 */
export function stampRunResults(
  root: string,
  view: Pick<ProjectTestRun, 'id' | 'groupId' | 'caseIds' | 'startedAt'>,
  snapshot: Map<string, string>,
  finishedAt: string = new Date().toISOString(),
): number {
  const ceiling = new Date(Date.parse(finishedAt) + CLOCK_SLACK_MS).toISOString();
  let stamped = 0;
  for (const group of readGroups(root)) {
    if (group.error) continue;
    if (view.groupId && group.id !== view.groupId) continue;
    let touched = false;
    const cases = group.cases.map((testCase) => {
      if (view.caseIds?.length && !view.caseIds.includes(testCase.id)) return testCase;
      const before = snapshot.get(`${group.id}:${testCase.id}`);
      if (before === fingerprint(testCase) || testCase.lastRunId === view.id) return testCase;
      // Новый кейс в отборе (агент завёл его сам) без единого результата — не итог.
      if (before === undefined && testCase.status === 'unknown') return testCase;
      const at = testCase.lastRunAt;
      const inWindow = !!at && at >= view.startedAt && at <= ceiling;
      touched = true;
      stamped += 1;
      return { ...testCase, lastRunId: view.id, lastRunAt: inWindow ? at : finishedAt };
    });
    if (touched) writeGroup(root, { ...group, cases });
  }
  return stamped;
}

/**
 * Режим, который проверяет приложение и оставляет результаты в кейсах.
 * Исследование сюда входит: его находки — новые кейсы с `failed`/`passed`, и
 * без штампа запись сессии показывала «0 из 0» при найденных багах.
 */
/**
 * Отпечатки содержимого кейсов отбора — снимаются ДО того, как агент тронет
 * дерево: прогон проверял код, каким он был на старте. Отбор по id сужает
 * набор; в запись попадут только кейсы с результатом (`stampsOf`).
 */
function startStamps(
  root: string,
  groups: readonly ProjectTestGroup[],
  groupId: string | undefined,
  caseIds: readonly string[] | undefined,
): Map<string, string> {
  const scoped = groupId ? groups.filter((group) => group.id === groupId) : groups;
  const picked = caseIds ? new Set(caseIds) : undefined;
  const keys = picked
    ? new Set(
        scoped.flatMap((group) =>
          group.cases.filter((item) => picked.has(item.id)).map((item) => `${group.id}:${item.id}`),
        ),
      )
    : undefined;
  return contentStamps(root, stampInputs(scoped, keys));
}

export function recordsResults(mode: ProjectTestRun['mode']): boolean {
  return mode === 'run' || mode === 'automate' || mode === 'explore';
}

/**
 * Что агент записал за этот прогон.
 *
 * Считаем по файлам кейсов, по штампу `lastRunId`: своего учёта у прогона нет и
 * быть не должно — статусы пишет агент, и второй счётчик в памяти неизбежно
 * разошёлся бы с файлами. Генерация результатов не даёт: она описывает
 * проверки, а не проходит их.
 */
export function collectResults(
  root: string,
  view: ProjectTestRun,
  redact?: (text: string) => string,
): ProjectTestPointResult[] {
  if (!recordsResults(view.mode)) return [];
  const hide = (value?: string): string | undefined => (value && redact ? redact(value) : value);
  const results: ProjectTestPointResult[] = [];
  for (const group of readGroups(root)) {
    if (group.error) continue;
    if (view.groupId && group.id !== view.groupId) continue;
    for (const testCase of group.cases) {
      if (view.caseIds?.length && !view.caseIds.includes(testCase.id)) continue;
      if (testCase.lastRunId !== view.id) continue;
      const at = testCase.lastRunAt ?? view.finishedAt ?? view.startedAt;
      results.push({
        pointId: pointId(group.id, testCase.id, view.environmentId),
        groupId: group.id,
        caseId: testCase.id,
        environmentId: view.environmentId,
        status: testCase.status,
        statusId: testCase.statusId,
        note: hide(testCase.note),
        startedAt: view.startedAt,
        finishedAt: at,
        attachments: testCase.attachments,
        failure: testCase.failure
          ? {
              ...testCase.failure,
              expected: hide(testCase.failure.expected),
              actual: hide(testCase.failure.actual),
            }
          : undefined,
        steps: failedStep(testCase, hide),
      });
    }
  }
  return results;
}

/**
 * Провалившийся шаг как результат шага.
 *
 * Поле `steps` в контракте было всегда, но агентские прогоны его не заполняли:
 * «провалился» без указания шага нельзя ни воспроизвести, ни завести дефектом.
 * Номер приходит от прогона в `failure.step` (с единицы), здесь он становится
 * индексом — тем самым, по которому разметка находит текст шага.
 */
function failedStep(
  testCase: ProjectTestCase,
  hide: (value?: string) => string | undefined,
): ProjectTestStepResult[] | undefined {
  const step = testCase.failure?.step;
  if (!step || step > testCase.steps.length) return undefined;
  return [
    {
      index: step - 1,
      status: testCase.status === 'blocked' ? 'blocked' : 'failed',
      note: hide(testCase.failure?.actual ?? testCase.note),
    },
  ];
}

/** Первая строка входа инструмента — по ней в логе видно, что происходит. */
function firstArg(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 160);
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.command ?? record.pattern ?? record.url ?? record.path;
  return typeof value === 'string' ? value.slice(0, 160) : '';
}

/** Лог растёт бесконечно — держим хвост: интересен конец, а не начало. */
function tail(text: string): string {
  return text.length > MAX_LOG ? text.slice(text.length - MAX_LOG) : text;
}

/**
 * Отчёт генерации рядом с отчётом заготовки (`results/junit.xml`), но со своим
 * именем: `results/` сверка папки пропускает (`SKIP_DIRS`), а файл убирается
 * после разбора.
 */
function runReportName(runId: string): string {
  return E2E_JUNIT_REPORT.replace(/\.xml$/, `-${runId}.xml`);
}
