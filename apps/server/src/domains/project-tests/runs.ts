import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type {
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRun,
  ProjectTestRunRecord,
  ProjectTestRunRequest,
} from '@agentdeck/contracts';
import { pointId, summarize as summarizeResults } from '@agentdeck/contracts/test-format';
import { ChatRun, type ChatEvent } from '../chat/ChatRunner.ts';
import type { RunNotice } from '../chat/ChatRunRegistry.ts';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  readGroups,
  resetStatuses,
} from './store.ts';
import { buildPrompt, runName, type PromptContext } from './prompt.ts';
import { readEnvironments, readSharedSteps } from './library.ts';
import { planCases, readPlan } from './plans.ts';
import { gitContext, impactOf, releaseTag } from './impact.ts';
import { writeRun } from './runs-store.ts';
import {
  runScope,
  startPermissionGate,
  type RunPermissionGate,
  type RunScope,
} from './run-permissions.ts';

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
 * Реестр живёт дольше запроса, поэтому создаётся в `bootstrap/runtime.ts` —
 * только оттуда прогоны можно погасить при выходе панели.
 */

/** Хвост лога: полный вывод агента за сотню кейсов — это мегабайты. */
const MAX_LOG = 200_000;

/** Одновременно идущий прогон на проект — один. */
export class ProjectTestRunRegistry {
  private readonly runs = new Map<
    string,
    { view: ProjectTestRun; run: ChatRun; gate?: RunPermissionGate }
  >();

  /**
   * Куда сообщить, что прогон кончился. Тот же отправитель, что у чатов:
   * регресс сотни кейсов идёт десятки минут, и человек всё это время не сидит
   * перед панелью. Наружу уходит только вид события и имя папки проекта.
   */
  private notify?: (notice: RunNotice) => void;

  setNotifier(notify: (notice: RunNotice) => void): void {
    this.notify = notify;
  }

  /** Прогон проекта: идущий или последний завершившийся. */
  get(projectPath: string): ProjectTestRun | undefined {
    return this.runs.get(projectPath)?.view;
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
    const entry = this.runs.get(projectPath);
    if (!entry || entry.view.status !== 'running') return undefined;
    if (entry.view.groupId && groupId && entry.view.groupId !== groupId) return undefined;
    return entry.view.id;
  }

  /**
   * Запустить прогон. Возвращает управление сразу: агент работает в фоне, а
   * клиент видит его по `GET /api/project-tests`.
   */
  start(request: ProjectTestRunRequest, now: string): ProjectTestRun {
    const root = request.projectPath;
    if (!existsSync(root)) throw new ProjectTestsError('Каталог проекта не найден.');

    const active = this.runs.get(root);
    if (active?.view.status === 'running') {
      throw new ProjectTestsError('Прогон по этому проекту уже идёт.');
    }

    const all = readGroups(root);
    const scoped = request.groupId ? all.filter((group) => group.id === request.groupId) : all;
    const caseIds = this.pickCases(root, all, request);

    if (request.mode === 'run' || request.mode === 'automate') {
      if (scoped.length === 0) throw new ProjectTestsError('Прогонять нечего: кейсов нет.');
      const broken = scoped.find((group) => group.error);
      if (broken) throw new ProjectTestsError(`Группа «${broken.id}»: ${broken.error}`);
      if (caseIds && caseIds.length === 0) {
        throw new ProjectTestsError(
          request.changedOnly
            ? 'Правки рабочей копии не задели ни одного кейса.'
            : 'Прогонять нечего: под отбор не попал ни один кейс.',
        );
      }
    }

    if (request.mode === 'run' && request.full) {
      for (const group of scoped) resetStatuses(root, group.id, caseIds);
    }

    const environments = readEnvironments(root);
    const environmentId =
      request.environmentId ??
      (request.planId ? readPlan(root, request.planId)?.environmentIds?.[0] : undefined);
    const { branch, commit } = gitContext(root);
    // Веху называет человек, а если не назвал — берём метку git: релиз,
    // помеченный тегом, отчёт узнаёт сам, и просить об этом ещё раз незачем.
    const release = request.release?.trim() || releaseTag(root);

    const view: ProjectTestRun = {
      id: randomUUID(),
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
    };

    // Кейсы читаем ПОСЛЕ возможного сброса статусов: иначе в задание уехали бы
    // галочки прошлого прогона, которые человек только что попросил забыть.
    const groups = request.full ? readGroups(root) : all;
    const context: PromptContext = {
      shared: readSharedSteps(root),
      environment: environments.find((item) => item.id === environmentId),
      impact: request.changedOnly ? impactOf(root, groups).cases : undefined,
    };
    const prompt = buildPrompt(
      request.groupId ? groups.filter((group) => group.id === request.groupId) : groups,
      { ...request, caseIds },
      context,
    );

    const run = new ChatRun();
    this.runs.set(root, { view, run });
    this.persist(root, view);

    const scope = runScope(
      root,
      request.mode,
      scoped.flatMap((group) => group.cases),
    );
    void this.launch(root, run, prompt, runName(request, scoped), scope);

    return view;
  }

  /**
   * Запуск агента с правами прогона.
   *
   * Прав спрашивать не у кого — человек прогон не сторожит, — поэтому решения
   * принимает сама панель: под прогон поднимается приёмник брокера прав
   * (`run-permissions.ts`), и каждый вызов инструмента сверяется с границами
   * режима. `bypassPermissions` остаётся ТОЛЬКО аварийным запасным путём: если
   * приёмник не поднялся, прогон должен всё равно состояться — иначе безопасность
   * превращается в «панель больше не гоняет тесты».
   */
  private async launch(
    root: string,
    run: ChatRun,
    prompt: string,
    name: string,
    scope: RunScope,
  ): Promise<void> {
    let gate: RunPermissionGate | undefined;
    try {
      gate = await startPermissionGate(scope, (tool, message) => this.note(root, tool, message));
      const entry = this.runs.get(root);
      if (entry) entry.gate = gate;
    } catch (error) {
      this.note(root, 'права', `приёмник прав не поднялся (${(error as Error).message})`);
    }

    try {
      await run.start(
        {
          prompt,
          cwd: root,
          name,
          // С приёмником — обычный режим: каждый вызов инструмента проходит через
          // границы прогона. Без него — прежний полный доступ, но об этом сказано
          // в логе прогона, а не молчком.
          permissionMode: gate ? 'default' : 'bypassPermissions',
          ...(gate ? { permissionPrompt: { runId: gate.runId, baseUrl: gate.baseUrl } } : {}),
        },
        (event) => this.consume(root, event),
      );
    } catch (error) {
      this.finish(root, 'error', (error as Error).message);
    }
  }

  /** Строка от панели в лог прогона — отказ прав или причина, почему их нет. */
  private note(projectPath: string, tool: string, message: string): void {
    const entry = this.runs.get(projectPath);
    if (!entry) return;
    entry.view.log = tail(`${entry.view.log}\n· панель: ${tool} — ${message}\n`);
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

    if (request.planId) {
      const plan = readPlan(root, request.planId);
      if (!plan) throw new ProjectTestsNotFoundError(`Плана «${request.planId}» в проекте нет.`);
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
  private consume(projectPath: string, event: ChatEvent): void {
    const entry = this.runs.get(projectPath);
    if (!entry) return;
    const view = entry.view;

    if (event.kind === 'session') view.sessionId = event.sessionId;
    if (event.kind === 'text') view.log = tail(view.log + event.text);
    if (event.kind === 'tool') {
      view.log = tail(`${view.log}\n· ${event.name} ${firstArg(event.input)}\n`);
    }
    if (event.kind === 'usage') {
      view.tokens += event.input + event.output + event.cacheRead + event.cacheCreation;
      view.costUsd += event.costUsd ?? 0;
    }
    if (event.kind === 'done') {
      view.sessionId = event.sessionId || view.sessionId;
      this.finish(projectPath, 'done');
    }
    if (event.kind === 'error') this.finish(projectPath, 'error', event.message);
  }

  private finish(projectPath: string, status: ProjectTestRun['status'], error?: string): void {
    const entry = this.runs.get(projectPath);
    if (!entry || entry.view.status !== 'running') return;
    // Приёмник прав живёт ровно столько, сколько прогон: открытый порт после
    // конца работы — это чужая дверь в решения о правах.
    entry.gate?.close();
    entry.gate = undefined;
    entry.view.status = status;
    entry.view.finishedAt = new Date().toISOString();
    if (error) entry.view.error = error;
    entry.view.results = collectResults(projectPath, entry.view);
    entry.view.summary = summarizeResults(entry.view.results);
    this.persist(projectPath, entry.view);
    // Об остановке рукой сообщать незачем: её сделал тот же человек, который
    // сейчас смотрит на панель.
    if (status !== 'stopped') {
      // Ключом идёт сессия CLI: прогон — это обычный разговор, и по нажатию на
      // уведомление телефон открывает именно его, а не пустой экран.
      this.notify?.({
        kind: status === 'error' ? 'error' : 'done',
        chatId: entry.view.sessionId ?? entry.view.id,
        projectPath,
      });
    }
  }

  /** Прогон в историю — той же формой, что и ручной. */
  private persist(projectPath: string, view: ProjectTestRun): void {
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
      tokens: view.tokens,
      costUsd: view.costUsd,
      sessionId: view.sessionId,
      results: view.results ?? [],
      summary: view.summary ?? summarizeResults(view.results ?? []),
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
 * Что агент успел записать за этот прогон.
 *
 * Считаем по файлам кейсов: результат — тот, у которого `lastRunAt` не раньше
 * старта. Своего учёта у прогона нет и быть не должно — статусы пишет агент, и
 * второй счётчик в памяти неизбежно разошёлся бы с файлами.
 */
function collectResults(root: string, view: ProjectTestRun): ProjectTestPointResult[] {
  const results: ProjectTestPointResult[] = [];
  for (const group of readGroups(root)) {
    if (group.error) continue;
    if (view.groupId && group.id !== view.groupId) continue;
    for (const testCase of group.cases) {
      if (view.caseIds?.length && !view.caseIds.includes(testCase.id)) continue;
      const at = testCase.lastRunAt;
      if (!at || at < view.startedAt) continue;
      results.push({
        pointId: pointId(group.id, testCase.id, view.environmentId),
        groupId: group.id,
        caseId: testCase.id,
        environmentId: view.environmentId,
        status: testCase.status,
        statusId: testCase.statusId,
        note: testCase.note,
        startedAt: view.startedAt,
        finishedAt: at,
        attachments: testCase.attachments,
      });
    }
  }
  return results;
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
