import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
import { ChatRun, type ChatEvent } from '../chat/ChatRunner.ts';
import type { RunNotice } from '../chat/ChatRunRegistry.ts';
import type { PlatformRunRoute } from '../platform/routing.ts';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  readGroups,
  resetStatuses,
  writeGroup,
} from './store.ts';
import { buildPrompt, runName, type PromptContext } from './prompt.ts';
import { applyDraft, confineDraft, draftFile, readDraft } from './drafts.ts';
import { stampOf } from './generate-sources.ts';
import { redactor } from './env-secrets.ts';
import { defaultEnvironment, readEnvironments, readSharedSteps } from './library.ts';
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
      run: ChatRun;
      gate?: RunPermissionGate;
      /** Принимать черновик генерации без просмотра — решение человека на старте. */
      autoAccept?: boolean;
      /** Затирание доступов стенда во всём, что выходит наружу. */
      redact?: (text: string) => string;
      /** Отпечатки кейсов отбора на старте — по ним видно, что агент тронул. */
      snapshot?: Map<string, string>;
    }
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

  /**
   * Маршрут контура для агента тестов (Т3) — тем же приёмом, что и у чатов:
   * реестр знает, что прогон его, а про контуры не знает ничего. Потребитель
   * здесь всегда один («тесты»), поэтому и спрашивается без аргументов.
   */
  private platformRouting?: () => PlatformRunRoute;

  setPlatformRouting(resolve: () => PlatformRunRoute): void {
    this.platformRouting = resolve;
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
  start(
    request: ProjectTestRunRequest,
    now: string,
    material?: ProjectTestGenerateMaterial,
    resolveSecrets?: RunSecretsResolver,
  ): ProjectTestRun {
    const root = request.projectPath;
    if (!existsSync(root)) throw new ProjectTestsError('Каталог проекта не найден.');

    const active = this.runs.get(root);
    if (active?.view.status === 'running') {
      throw new ProjectTestsError('Прогон по этому проекту уже идёт.');
    }

    const all = readGroups(root);
    const scoped = request.groupId ? all.filter((group) => group.id === request.groupId) : all;
    if (request.groupId && scoped.length === 0) {
      throw new ProjectTestsNotFoundError(`Группы «${request.groupId}» в проекте нет.`);
    }
    const caseIds = this.pickCases(root, all, request);

    // Исследование без хартии — это блуждание: агент час ходит по приложению и
    // приносит десяток кейсов ни о чём. Хартию задаёт то же поле пожелания, и
    // отказ здесь дешевле такого прогона.
    if (request.mode === 'explore' && !request.scope?.trim()) {
      throw new ProjectTestsError(
        'Исследование идёт по хартии: напишите в поле пожелания, что именно смотреть ' +
          '(«вложения в чате», «права на страницах проекта»).',
      );
    }

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

    // Автоматизировать уже автоматизированное значит переписать работающие
    // тесты заново. Кейс с `automated` задание и так велит пропускать — но
    // прогон, у которого таких кейсов ВСЕ, запускать незачем.
    if (request.mode === 'automate' && !hasWorkToAutomate(scoped, caseIds)) {
      throw new ProjectTestsError('Автоматизировать нечего: кейсы отбора уже помечены automated.');
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
      // След источника едет в запись прогона: черновик применяют позже, иногда
      // через день, и к тому времени материал взять уже неоткуда.
      generate: stampOf(material),
    };

    // Кейсы читаем ПОСЛЕ возможного сброса статусов: иначе в задание уехали бы
    // галочки прошлого прогона, которые человек только что попросил забыть.
    const groups = request.full ? readGroups(root) : all;
    const environment = environments.find((item) => item.id === environmentId);
    // Доступы стенда: значения уедут переменными окружения процесса CLI, а в
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
    };
    const prompt = buildPrompt(
      request.groupId ? groups.filter((group) => group.id === request.groupId) : groups,
      { ...request, caseIds },
      context,
    );

    const run = new ChatRun();
    this.runs.set(root, {
      view,
      run,
      autoAccept: request.autoAccept === true,
      redact: redactor(secrets.values),
      snapshot: fingerprintCases(groups, view),
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
    this.persist(root, view);

    const scope = runScope(
      root,
      request.mode,
      scoped.flatMap((group) => group.cases),
    );
    void this.launch(root, run, prompt, runName(request, scoped), scope, secrets.values);

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
    env: Record<string, string>,
  ): Promise<void> {
    let gate: RunPermissionGate | undefined;
    try {
      gate = await startPermissionGate(scope, (tool, message) => this.note(root, tool, message));
      const entry = this.runs.get(root);
      if (entry) entry.gate = gate;
    } catch (error) {
      this.note(root, 'права', `приёмник прав не поднялся (${(error as Error).message})`);
    }

    // Маршрут контура — на КАЖДОМ запуске: снятая галочка обязана действовать
    // со следующего прогона.
    const route = this.platformRouting?.() ?? { env: {} };
    try {
      // Обязательный контур без шлюза или ключа: мимо него агент не идёт.
      if (route.refusal) throw new Error(route.refusal);
      await run.start(
        {
          prompt,
          cwd: root,
          name,
          // Доступы стенда идут ТОЛЬКО так: переменные процесса CLI не видны ни
          // в задании, ни в записи прогона, ни в чужом ответе API.
          ...(Object.keys(env).length > 0 ? { env } : {}),
          // Маршрут контура — отдельным полем и на КАЖДОМ запуске: снятая
          // галочка обязана действовать со следующего прогона.
          platformEnv: route.env,
          // Свой промпт контура — и агенту тестов тоже: через контур ходит
          // модель среднего класса, и полный промпт CLI топит её одинаково,
          // о чём бы её ни просили (Т5.4а).
          platformSystemPrompt: route.systemPrompt ?? '',
          // И наши слои (Т8): агент тестов ходит тем же маршрутом, и снятые
          // правила обязаны сниматься и у него — иначе «прогон без наших слоёв»
          // означал бы «без них в чате, со всеми в тестах».
          platformArgs: route.layers?.args ?? [],
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
        throw new ProjectTestsError(
          `Кейсов «${missing.slice(0, 5).join('», «')}» в отборе нет — проверьте id.`,
        );
      }
      ids = [...new Set(ids.map((id) => known.get(id) as string))];
    }

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

    // Агент читает пароль из своего окружения и может повторить его в выводе —
    // например, показав команду входа целиком. В лог он попадать не должен: лог
    // видит человек, он же уезжает на телефон уведомлением.
    const hide = entry.redact ?? ((value: string) => value);

    if (event.kind === 'session') view.sessionId = event.sessionId;
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
    if (error) entry.view.error = entry.redact ? entry.redact(error) : error;
    // Заметки к кейсам пишет агент, а они уезжают в историю прогонов — файл в
    // git проверяемого проекта. Секрет, попавший в «не пустил с паролем …»,
    // остался бы там навсегда.
    if (entry.view.mode === 'run' || entry.view.mode === 'automate') {
      stampRunResults(projectPath, entry.view, entry.snapshot ?? new Map(), entry.view.finishedAt);
    }
    entry.view.results = collectResults(projectPath, entry.view, entry.redact);
    entry.view.summary = summarizeResults(entry.view.results);
    if (entry.view.mode === 'generate' || entry.view.mode === 'run') {
      this.settleDraft(projectPath, entry.view, entry.autoAccept === true);
    }
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
    const written = readDraft(root, view.id);
    if (!written) return;
    // Группу выбрал человек; агент её советом считает, панель — правилом.
    const draft = confineDraft(root, written, view.groupId);
    if (draft.error) {
      this.note(root, 'черновик', draft.error);
      return;
    }

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
      draft: view.draft,
      generate: view.generate,
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
 * Что агент записал за этот прогон.
 *
 * Считаем по файлам кейсов, по штампу `lastRunId`: своего учёта у прогона нет и
 * быть не должно — статусы пишет агент, и второй счётчик в памяти неизбежно
 * разошёлся бы с файлами. Генерация и исследование результатов не дают: они
 * описывают проверки, а не проходят их.
 */
export function collectResults(
  root: string,
  view: ProjectTestRun,
  redact?: (text: string) => string,
): ProjectTestPointResult[] {
  if (view.mode === 'generate' || view.mode === 'explore') return [];
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
