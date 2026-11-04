import type { AskFields } from '@agentdeck/contracts/core/ask';
import { estimateFieldsSchema, type EstimateFields } from '@agentdeck/contracts/core/estimate';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { sessionEventKeys } from '@agentdeck/contracts/core/session-stream';
import { ASK_MACHINE, STEP_MACHINE } from '@agentdeck/contracts/core/states';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { CoreChatPort } from '../../chat/core-run/core-run.types.ts';
import { translate, TURN_ERROR_TEXT } from '../../chat/core-run/translate.ts';
import type { TestsAgentEvent } from './agent-run.types.ts';

/**
 * Прогон агента блока «Тесты» через ядро (этап 10, F6, шаг 4): своего процесса CLI у панели нет —
 * прогон идёт задачей ядра `chat@1` прямо в корне проекта (грант правки на этот корень), CLI —
 * потомок хоста сеанса ядра, дорогой ядра: переходник с хуком ядра, судья права, журнал, маршрут
 * и контур, экономика. Claude, Qwen Code и Codex — один путь, переходник называет `set-cli`.
 *
 * Прогон — один ход: задание уходит первым сообщением, на конце первого хода панель закрывает шаг
 * (`end-chat`) и собирает итог из файлов кейсов, как раньше. Человека у прогона нет, поэтому вопрос
 * права, поднятый ядром (`human.asked`, источник `permit`), получает отказ сразу — ждать его
 * некому, а висящий вопрос держал бы шаг до суток. «Стоп» — команда ядру `cancel`.
 *
 * Границы режима уходят ядру данными (`session.scope`): правку вне масок и команды, двигающие
 * историю, отказывает судья ядра. Доступы стенда — окружение задачи (`env`: имена в журнал,
 * значения только в память ядра). Галочка контура «tests» — разрешённый набор задачи (`routes`,
 * `set-route` до запуска). Тем же путём идёт `/run` песочницы: без брифа ядра, источник — только
 * слой человека, каталог конфигурации — окружением задачи.
 */

export const TESTS_CORE_STOP_REASON = 'tests run stopped by the human in the panel';
/** Причина снятия задачи сироты: панель перезапустилась посреди прогона, хозяина у задачи нет. */
export const TESTS_CORE_ORPHAN_REASON = 'tests run orphaned: the panel restarted mid-run';
/** Переходники ядра, которыми идёт агент тестов (прежние три диалекта панели). */
export const TESTS_CORE_ADAPTERS = ['claude', 'qwen', 'codex'] as const;
export type TestsCoreAdapter = (typeof TESTS_CORE_ADAPTERS)[number];

const POLL_MS = 200;
const WAIT_MS = 60_000;
const TITLE_MAX = 80;

export interface TestsCoreStart {
  adapter: TestsCoreAdapter;
  /** Имя CLI для человека — подстановка в тексты отказов. */
  providerName: string;
  prompt: string;
  /** Корень проекта — место прогона (на месте, без копии). */
  cwd: string;
  /** Имя прогона в списке задач ядра. */
  title: string;
  lang?: 'ru' | 'en';
  /**
   * Настройки сеанса задачи ядра (этап 10, F6): границы правки (агент тестов), без брифа ядра и
   * только источник человека (песочница). Имена окружения сюда не входят — их называет `env`.
   */
  session?: Omit<NonNullable<EstimateFields['session']>, 'env'>;
  /**
   * Окружение задачи: имена уходят в `session.env`, значения — телом оценки, ядро держит их только
   * в памяти до конца задачи (доступы стенда, каталог конфигурации песочницы).
   */
  env?: Record<string, string>;
  /** Разрешённый набор задачи до запуска (`set-route`) — маршрут контура; нет — набор ядра. */
  routes?: NonNullable<AskFields['routes']>;
  /** Отказ своим текстом (песочница); нет — текст прогона тестов. */
  refused?: (reason: string) => TestsAgentEvent;
}

export interface TestsCoreRunDeps {
  port: CoreChatPort;
  /** Отказ права, принятый за человека, — строкой в лог прогона. */
  onDeny?: (tool: string, message: string) => void;
  /** Причина снятия задачи по «Стоп» в журнале ядра; нет — причина прогона тестов. */
  stopReason?: string;
  pollMs?: number;
  waitMs?: number;
  now?: () => number;
}

const stepClosed = (state: string): boolean =>
  (STEP_MACHINE.terminal as readonly string[]).includes(state);
const askClosed = (state: string): boolean =>
  (ASK_MACHINE.terminal as readonly string[]).includes(state);

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export function testsCoreAdapterOf(providerId: string): TestsCoreAdapter | undefined {
  return (TESTS_CORE_ADAPTERS as readonly string[]).includes(providerId)
    ? (providerId as TestsCoreAdapter)
    : undefined;
}

export function testsCoreTitle(name: string): string {
  const one = name.replace(/\s+/g, ' ').trim() || 'tests run';
  return one.length > TITLE_MAX ? `${one.slice(0, TITLE_MAX - 1)}…` : one;
}

/** Отказ ядра в словаре прогона: код текста + причина ядра дословно. */
function refused(provider: string, reason: string): TestsAgentEvent {
  return {
    kind: 'error',
    message: `Ядро не запустило прогон на ${provider}: ${reason}`,
    messageCode: 'tests-agent-core-refused',
    params: { provider, reason },
  };
}

const refusalOf = (options: TestsCoreStart, reason: string): TestsAgentEvent =>
  options.refused ? options.refused(reason) : refused(options.providerName, reason);

/** Имя переменной, которое примет ядро (`taskEnvNameSchema` контрактов). */
const TASK_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Имена, которые ядро держит само (`conductor/task-env` ядра): вызывающему их не задать. */
const CORE_OWNED_ENV =
  /^(PATH|PATHEXT|SystemRoot|SYSTEMROOT|windir|ComSpec|NODE_OPTIONS|AGENTDECK_.*)$/i;
/** Потолки схемы ядра: имён — 32, значение — 32 000 символов. */
const TASK_ENV_MAX = 32;
const TASK_ENV_VALUE_MAX = 32_000;

/**
 * Окружение задачи, которое ядро примет, и имена, которые оно отказало бы: отказ одного имени
 * ронял бы оценку целиком (422), поэтому негодное отсекается здесь и называется вызывающим.
 */
export function taskEnvOf(
  values: Record<string, string>,
  /** Мест потолка, уже занятых слоем панели (G13): его переменные идут сверх этих значений. */
  reserved = 0,
): {
  env: Record<string, string>;
  dropped: string[];
} {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const fits =
      TASK_ENV_NAME.test(name) &&
      !CORE_OWNED_ENV.test(name) &&
      value.length <= TASK_ENV_VALUE_MAX &&
      Object.keys(env).length < TASK_ENV_MAX - reserved;
    if (fits) env[name] = value;
    else dropped.push(name);
  }
  return { env, dropped };
}

/** Настройки сеанса оценки: границы и бриф от вызывающего, имена окружения — ключи `env`. */
function sessionOf(options: TestsCoreStart): EstimateFields['session'] {
  const names = Object.keys(options.env ?? {});
  const session = { ...options.session, ...(names.length > 0 ? { env: names } : {}) };
  return Object.keys(session).length > 0 ? session : undefined;
}

export class TestsCoreRun {
  private readonly abort = new AbortController();
  private stopped = false;
  private task: string | undefined;
  private readonly deps: TestsCoreRunDeps;

  constructor(deps: TestsCoreRunDeps) {
    this.deps = deps;
  }

  /** Процесс CLI держит хост сеанса ядра: у панели номера процесса нет. */
  readonly pid: number | undefined = undefined;

  /** Задача ядра прогона — известна после оценки. */
  taskId(): string | undefined {
    return this.task;
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    const { task } = this;
    if (task) {
      void this.deps.port
        .command(task, 'cancel', { reason: this.deps.stopReason ?? TESTS_CORE_STOP_REASON })
        .catch(() => undefined);
    }
  }

  async start(options: TestsCoreStart, onEvent: (event: TestsAgentEvent) => void): Promise<void> {
    const startedAt = this.now;
    // После «Стоп» прогон молчит: итог «остановлен» уже записал реестр.
    const emit = (event: TestsAgentEvent): void => {
      if (!this.stopped) onEvent(event);
    };
    try {
      const placed = await this.place(options);
      if (!placed) return;
      if ('error' in placed) return emit(refusalOf(options, placed.error));
      emit({ kind: 'session', sessionId: placed.sessionId, model: '', tools: 0, startedAt });
      this.refusePermits(placed.taskId, placed.stepId);
      await this.readTurn(placed, options, emit, startedAt);
    } catch (error) {
      if (this.stopped) return;
      emit(refusalOf(options, error instanceof Error ? error.message : String(error)));
    } finally {
      this.abort.abort();
    }
  }

  private async place(
    options: TestsCoreStart,
  ): Promise<{ taskId: string; stepId: string; sessionId: string } | { error: string } | null> {
    const { port } = this.deps;
    const parsed = estimateFieldsSchema.safeParse({
      title: testsCoreTitle(options.title),
      request: options.prompt,
      repos: [{ path: options.cwd, baseRef: null }],
      scenario: { preset: 'chat' },
      launchPolicy: 'confirm',
      ciWait: false,
      // Прогон пишет статусы кейсов, черновики и спеки в рабочее дерево проекта: старт прогона
      // человеком и есть грант правки на этот корень (как начало чата).
      placement: { kind: 'in-place', grant: { project: options.cwd, ops: ['edit'] } },
      ...(options.lang ? { lang: options.lang } : {}),
      ...(sessionOf(options) ? { session: sessionOf(options) } : {}),
    });
    if (!parsed.success) {
      return {
        error: `the run does not fit a core estimate: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }
    const env = options.env && Object.keys(options.env).length > 0 ? options.env : undefined;
    const estimate = await port.estimate(parsed.data, env);
    if (!estimate.ok) return { error: `${estimate.code}: ${estimate.message}` };
    const taskId = estimate.taskId;
    this.task = taskId;
    if (this.stopped) {
      this.stopTask();
      return null;
    }
    const commands: Array<[Parameters<CoreChatPort['command']>[1], Record<string, unknown>]> = [
      ['set-cli', { scope: 'task', scopeId: taskId, adapter: options.adapter, timing: 'now' }],
      // Маршрут контура (галочка потребителя): тем же ходом человека, что и смена маршрута в чате.
      ...(options.routes?.length
        ? [
            ['set-route', { scope: 'task', scopeId: taskId, allowedRoutes: options.routes }] as [
              Parameters<CoreChatPort['command']>[1],
              Record<string, unknown>,
            ],
          ]
        : []),
      ['launch', {}],
    ];
    for (const [kind, fields] of commands) {
      const out = await port.command(taskId, kind, fields);
      if (out.status !== 'applied') {
        this.stopTask();
        return { error: `${kind} ${out.code ?? 'rejected'}: ${out.reason ?? ''}`.trim() };
      }
    }
    const step = await this.waitSession(taskId);
    if (this.stopped) {
      this.stopTask();
      return null;
    }
    return { taskId, ...step };
  }

  private stopTask(): void {
    const { task } = this;
    if (!task) return;
    void this.deps.port
      .command(task, 'cancel', { reason: this.deps.stopReason ?? TESTS_CORE_STOP_REASON })
      .catch(() => undefined);
  }

  /** Шаг `chat` и сеанс после `after` (первый — без него); шаг кончился без сеанса — отказ. */
  private async waitSession(
    taskId: string,
    stepId?: string,
    after?: string,
  ): Promise<{ stepId: string; sessionId: string }> {
    const deadline = this.now + (this.deps.waitMs ?? WAIT_MS);
    while (!this.abort.signal.aborted && this.now < deadline) {
      const view = await this.deps.port.view(taskId).catch(() => null);
      const step = view ? chatStep(view, stepId) : undefined;
      if (view && step) {
        const session = sessionAfter(view, step.stepId, after);
        if (session) return { stepId: step.stepId, sessionId: session.sessionId };
        if (stepClosed(step.state)) {
          throw new Error(
            `the step ended without a session (${step.outcome ?? step.state}): ${step.reason ?? ''}`.trim(),
          );
        }
      }
      if (view?.ended) throw new Error(`the core task ended (${view.ended})`);
      await sleep(this.deps.pollMs ?? POLL_MS, this.abort.signal);
    }
    if (this.abort.signal.aborted) throw new Error('stopped');
    throw new Error('the core opened no session for the run');
  }

  /** Вид сеанса до конца первого хода; сеанс оборвался — ядро продолжает шаг новым сеансом. */
  private async readTurn(
    placed: { taskId: string; stepId: string; sessionId: string },
    options: TestsCoreStart,
    emit: (event: TestsAgentEvent) => void,
    startedAt: number,
  ): Promise<void> {
    const { port } = this.deps;
    let sessionId = placed.sessionId;
    for (;;) {
      const seen = new Set<string>();
      for await (const page of port.follow(placed.taskId, sessionId, 0, this.abort.signal)) {
        const keys = sessionEventKeys(page.events);
        for (const [i, event] of page.events.entries()) {
          const key = keys[i]!;
          if (seen.has(key)) continue;
          seen.add(key);
          const out = translate(event);
          if (out.kind === 'event') {
            const e = out.event;
            // Лог прогона знает текст, вызовы, расход и ошибку; прочее (мысли, итоги вызовов) — лента чата.
            if (e.kind === 'text' || e.kind === 'tool' || e.kind === 'usage') emit(e);
            if (e.kind === 'error') {
              emit(refusalOf(options, e.message));
              await this.close(placed);
              return;
            }
          }
          if (out.kind === 'turn-end') {
            await this.close(placed);
            if (out.isError) {
              emit(refusalOf(options, out.text ?? TURN_ERROR_TEXT));
              return;
            }
            emit({
              kind: 'done',
              costUsd: 0,
              durationMs: Math.max(0, this.now - startedAt),
              sessionId: placed.sessionId,
            });
            return;
          }
        }
        if (page.done) break;
      }
      if (this.stopped) return;
      const next = await this.waitSession(placed.taskId, placed.stepId, sessionId).catch(
        (error: unknown) => {
          throw new Error(
            `the core session ended before the run finished (${error instanceof Error ? error.message : String(error)})`,
          );
        },
      );
      sessionId = next.sessionId;
    }
  }

  /** Конец прогона — конец шага: чат ядра иначе ждал бы следующего слова человека. */
  private async close(placed: { taskId: string; stepId: string }): Promise<void> {
    const out = await this.deps.port
      .command(placed.taskId, 'end-chat', { stepId: placed.stepId })
      .catch(() => undefined);
    if (out?.status !== 'applied') this.stopTask();
  }

  /** Вопросы права шага — отказ за отсутствующего человека, строкой в лог прогона. */
  private refusePermits(taskId: string, stepId: string): void {
    const { port } = this.deps;
    const answered = new Set<string>();
    void (async () => {
      for await (const line of port.taskEvents(taskId, this.abort.signal)) {
        const ask = permitAsk(line, stepId);
        if (!ask || answered.has(ask.askId)) continue;
        answered.add(ask.askId);
        const view = await port.view(taskId).catch(() => null);
        const known = view?.asks.find((a) => a.askId === ask.askId);
        if (!known || askClosed(known.state)) continue;
        this.deps.onDeny?.(
          'права',
          `ядро спросило «${ask.question}» — человека у прогона нет, отказано`,
        );
        await port
          .command(taskId, 'answer', { askId: ask.askId, answer: 'refuse' })
          .catch(() => undefined);
      }
    })().catch(() => undefined);
  }
}

function permitAsk(
  line: JournalLine,
  stepId: string,
): { askId: string; question: string } | undefined {
  if (line.kind !== 'human.asked' || line.stepId !== stepId) return undefined;
  const data = line.data as { askId?: unknown; source?: unknown; question?: unknown };
  if (data.source !== 'permit' || typeof data.askId !== 'string') return undefined;
  return { askId: data.askId, question: typeof data.question === 'string' ? data.question : '' };
}

function chatStep(
  view: TaskView,
  stepId: string | undefined,
): TaskView['steps'][number] | undefined {
  if (stepId) return view.steps.find((s) => s.stepId === stepId);
  return view.steps
    .filter((s) => s.stepKind === 'chat')
    .sort((a, b) => b.startedSeq - a.startedSeq)[0];
}

function sessionAfter(
  view: TaskView,
  stepId: string,
  after: string | undefined,
): TaskView['sessions'][number] | undefined {
  const ordered = view.sessions
    .filter((s) => s.stepId === stepId)
    .sort((a, b) => a.startedSeq - b.startedSeq);
  if (!after) return ordered[0];
  const at = ordered.findIndex((s) => s.sessionId === after);
  return at === -1 ? undefined : ordered[at + 1];
}
