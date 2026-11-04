import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CORE_PERMIT_TOOL } from '@agentdeck/contracts/chat-handoff';
import { estimateFieldsSchema, type ChatAttachment } from '@agentdeck/contracts/core/estimate';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { humanTextOf, sessionEventKeys } from '@agentdeck/contracts/core/session-stream';
import { ASK_MACHINE, STEP_MACHINE } from '@agentdeck/contracts/core/states';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { joinAttachments, splitAttachments } from '@agentdeck/contracts/uploads';
import { contourModelOf } from '../../platform/routing/core-contour.ts';
import { sandboxRoot } from '../ChatArtifacts/ChatArtifacts.ts';
import type { ChatEvent } from '../chat-events.ts';
import type { RunOptions } from '../run-options/run-options.ts';
import type { RunLike } from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { CoreChatRunDeps } from './core-run.types.ts';
import { coreRefusalText } from './refusal-text.ts';
import { carryOfRunOptions } from './session-carry.ts';
import { translate, TURN_ERROR_TEXT } from './translate.ts';

/**
 * Ход чата Claude через ядро (этап 10, F2, проход 3): у панели больше нет своего процесса CLI для
 * `/chat` — ход идёт задачей ядра `chat@1` прямо в папке проекта, CLI — потомок хоста сеанса ядра.
 * Реестр прогонов, вкладка и сторожа не меняются: прогон говорит словарём прежнего исполнителя.
 *
 * Дорога хода:
 * - разговор уже ведёт живой шаг `chat` (книга + вид задачи) — сообщение шагу (`message-to-step`),
 *   ядро доставит его на границе хода;
 * - иначе — оценка с пресетом `chat` (на месте, грант правки на корень), `resume` с id разговора,
 *   если он есть, затем `set-cli claude`, модель хода и запуск.
 * Чтение — вид сеанса с конца прошлого хода до ближайшего конца хода. Ядро недоступно или
 * отказало — ошибка с причиной ядра; тихого отката на прежний исполнитель нет.
 */

export const CORE_CHAT_STOP_REASON = 'stopped by the human in the panel';

const POLL_MS = 200;
const WAIT_MS = 60_000;
const TITLE_MAX = 80;

const stepClosed = (state: string): boolean =>
  (STEP_MACHINE.terminal as readonly string[]).includes(state);
const askClosed = (state: string): boolean =>
  (ASK_MACHINE.terminal as readonly string[]).includes(state);

/**
 * Чего у ядра для этого хода нет — отказ по имени вместо тихой потери: ветвление при правке
 * сообщения (у переходника claude нет `--fork-session`), разовый пинг тёплого кэша и ход, который
 * начал сам CLI (CLI держит хост сеанса ядра, а не панель).
 */
export function coreChatRefusal(options: RunOptions): string | undefined {
  if (options.ephemeral || options.denyTools) {
    return 'core chat: the keep-warm ping has no core path (one-off forked turn without a transcript)';
  }
  if (options.fork) {
    return 'core chat: editing a sent message (fork) has no core path — the core claude adapter has no --fork-session';
  }
  if (options.wake || options.hold) {
    return 'core chat: a turn started by the CLI itself has no panel path — the core session host owns the CLI';
  }
  return undefined;
}

export function chatTitle(prompt: string): string {
  const first =
    prompt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? 'chat';
  return first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1)}…` : first;
}

/**
 * Слово хода (s10 G11): текст человека, вложения панели байтами (ядро кладёт их копии в задачу —
 * сеанс ядра читает только их, файл в доме панели ему закрыт) и пути, которые панель не писала —
 * они остаются в тексте как есть и судятся правом чтения сеанса.
 */
interface Turn {
  text: string;
  attachments: ChatAttachment[];
}

export function turnOf(prompt: string, uploadsRoot: string): Turn {
  const split = splitAttachments(prompt);
  const attachments: ChatAttachment[] = [];
  const kept: string[] = [];
  for (const file of split.files) {
    const rel = relative(uploadsRoot, resolve(file));
    const ours = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    if (!ours) {
      kept.push(file);
      continue;
    }
    attachments.push({ name: basename(file), base64: readFileSync(file).toString('base64') });
  }
  return { text: joinAttachments(split.text, kept), attachments };
}

interface Placed {
  taskId: string;
  stepId: string;
  sessionId: string;
  /** С какого смещения вида сеанса начинается этот ход. */
  from: number;
  conversationId: string;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export class CoreChatRun implements RunLike {
  private readonly abort = new AbortController();
  private stopped = false;
  private taskId: string | undefined;
  private stepId: string | undefined;
  private conversationId: string | undefined;
  private readonly asked = new Set<string>();
  /** Конец хода уже отдан ленте: слово «на ходу» больше некому показать — его шлют новым ходом. */
  private finished = false;
  /**
   * Слова «на ходу», ещё не доставленные ядром. Ядро отдаёт их сеансу только на границе хода, и
   * каждое начинает свой ход ПОСЛЕ текущего: конец текущего хода прогон не кончает, пока все они
   * не появились в виде сеанса (`user-text`) — иначе их ход шёл бы без ленты и без «Остановить».
   */
  private readonly owed: string[] = [];
  /** Конец хода придержан ради слова «на ходу»; отказ ядра в нём будит чтение (`release`). */
  private held = false;
  private release: (() => void) | null = null;

  private readonly deps: CoreChatRunDeps;

  constructor(deps: CoreChatRunDeps) {
    this.deps = deps;
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    const refusal = coreChatRefusal(options);
    if (refusal) throw new Error(refusal);
    const startedAt = this.now;
    try {
      const placed = await this.place(options);
      if (!placed) return;
      onEvent({
        kind: 'session',
        sessionId: placed.conversationId,
        model: options.model ?? '',
        tools: 0,
        startedAt,
      });
      this.watchPermits(placed, options, onEvent);
      await this.readTurn(placed, onEvent, startedAt);
    } catch (error) {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      const raw = message.startsWith('core chat:') ? message : `core chat: ${message}`;
      // Отказ ядра — текстом панели по коду (s10 G7); слова ядра — в причине ошибки.
      throw new Error(coreRefusalText(raw) ?? raw, { cause: error });
    } finally {
      this.abort.abort();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.cancel();
  }

  /** Сообщение посреди хода — тому же шагу; ядро доставит его на ближайшей границе хода. */
  steer(prompt: string): boolean {
    const { taskId, stepId } = this;
    if (this.stopped || this.finished || !taskId || !stepId || !prompt.trim()) return false;
    this.owed.push(prompt);
    // Отказ ядра (шаг кончился) или ядро недоступно — доставки не будет, ждать её нечего.
    const drop = (): void => {
      const at = this.owed.indexOf(prompt);
      if (at >= 0) this.owed.splice(at, 1);
      if (this.owed.length === 0 && this.held) this.release?.();
    };
    void this.deps.port
      .command(taskId, 'message-to-step', { stepId, text: prompt })
      .then((outcome) => {
        if (outcome.status !== 'applied') drop();
      })
      .catch(drop);
    return true;
  }

  /** Доставленное ядром слово человека (`user-text` с шапкой доставки) снимает его с ожидания. */
  private delivered(text: unknown): void {
    if (typeof text !== 'string' || this.owed.length === 0) return;
    const said = humanTextOf(text).trim();
    const at = this.owed.findIndex((p) => p.trim() === said);
    if (at >= 0) this.owed.splice(at, 1);
  }

  /** Отмена задачи ядра; следующий ход начнёт новую задачу с продолжением разговора. */
  private cancel(): void {
    const { taskId, conversationId } = this;
    if (conversationId) this.deps.book.forget(conversationId);
    if (!taskId) return;
    void this.deps.port
      .command(taskId, 'cancel', { reason: CORE_CHAT_STOP_REASON })
      .catch(() => undefined);
  }

  private async place(options: RunOptions): Promise<Placed | null> {
    const conversation = options.sessionId;
    const turn = turnOf(options.prompt, this.deps.uploadsRoot ?? sandboxRoot());
    if (conversation) {
      const live = await this.continueLive(conversation, turn);
      if (live) return live;
    }
    return this.startTask(options, conversation, turn);
  }

  /** Живой шаг разговора: сообщение ему; шаг закрыт или ядро его не знает — `null`. */
  private async continueLive(conversation: string, turn: Turn): Promise<Placed | null> {
    const { port, book } = this.deps;
    const entry = book.get(conversation);
    if (!entry) return null;
    const view = await port.view(entry.taskId);
    const step = view?.steps.find((s) => s.stepId === entry.stepId);
    const session = view ? latestSession(view, entry.stepId) : undefined;
    if (!view || view.ended || !step || stepClosed(step.state) || !session) {
      book.forget(conversation);
      return null;
    }
    // Ход начинается с конца уже записанного: прошлые ходы лента знает из транскрипта.
    const { next } = await port.page(entry.taskId, session.sessionId, 0);
    this.taskId = entry.taskId;
    this.stepId = entry.stepId;
    this.conversationId = conversation;
    // Вложения — копиями ядра в этой задаче: сеанс читает их, а не файл в доме панели.
    const files: string[] = [];
    for (const attachment of turn.attachments) {
      const stored = await port.attach(entry.taskId, attachment);
      if (!stored.ok) {
        throw new Error(
          `core chat: the core refused the attachment ${attachment.name} (${stored.code}): ${stored.message}`,
        );
      }
      files.push(stored.file);
    }
    const sent = await port.command(entry.taskId, 'message-to-step', {
      stepId: entry.stepId,
      text: joinAttachments(turn.text, files),
    });
    if (sent.status !== 'applied') {
      // Шаг закрылся между видом и командой: разговор продолжит новая задача.
      book.forget(conversation);
      this.taskId = undefined;
      this.stepId = undefined;
      return null;
    }
    return {
      taskId: entry.taskId,
      stepId: entry.stepId,
      sessionId: session.sessionId,
      from: next,
      conversationId: conversation,
    };
  }

  private async startTask(
    options: RunOptions,
    conversation: string | undefined,
    turn: Turn,
  ): Promise<Placed | null> {
    const { port, book } = this.deps;
    // Слой панели этого старта (G6): строка о тестах, строка профиля, набор, флаги наших слоёв.
    // Закрепляется на задаче: следующие ходы идут сообщением тому же шагу.
    const carried = carryOfRunOptions(options);
    if (!carried.ok) {
      throw new Error(
        `core chat: the panel layer does not fit the core session: ${carried.reason}`,
      );
    }
    // Блок вложений пишет ядро — путями своих копий; без текста запрос — имена файлов.
    const request = turn.text || turn.attachments.map((a) => a.name).join(', ') || options.prompt;
    const parsed = estimateFieldsSchema.safeParse({
      title: chatTitle(request),
      request,
      repos: [{ path: options.cwd, baseRef: null }],
      scenario: { preset: 'chat' },
      launchPolicy: 'confirm',
      ciWait: false,
      // Чат идёт в проекте человека: начало чата и есть грант правки на этот корень (Q1).
      placement: { kind: 'in-place', grant: { project: options.cwd, ops: ['edit'] } },
      ...(conversation ? { resume: { adapter: 'claude', conversationId: conversation } } : {}),
      session: carried.carry.session,
    });
    if (!parsed.success) {
      throw new Error(
        `core chat: the turn does not fit a core estimate: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const estimate = await port.estimate(parsed.data, carried.carry.env, turn.attachments);
    if (!estimate.ok) {
      throw new Error(
        `core chat: the core refused the chat (${estimate.code}): ${estimate.message}`,
      );
    }
    const taskId = estimate.taskId;
    this.taskId = taskId;
    if (this.stopped) {
      this.cancel();
      return null;
    }
    // Галочка «Чат» контура (и обязательный контур) — разрешённый набор задачи, ДО выбора CLI:
    // как у чата чужого CLI (`core-foreign-start.ts`), иначе ход шёл мимо контура.
    // Через контур модель — его перевод выбора человека (s10 G7, `contourModelOf`): имя вендора,
    // которого контур не знает, ядро отказало бы под шаблоном контура; усилие контуру не уезжает.
    const routes = this.deps.routes?.(options.model ?? '');
    const contourModel = contourModelOf(routes);
    // Выбора нет — `set-model` не нужен: модель маршрута ядро возьмёт само (`modelOn`, «route»).
    const model = options.model ? (contourModel ?? options.model) : undefined;
    const effort = contourModel ? null : options.effort || null;
    const commands: Array<[Parameters<typeof port.command>[1], Record<string, unknown>]> = [
      ...(routes?.length
        ? ([['set-route', { scope: 'task', scopeId: taskId, allowedRoutes: routes }]] as Array<
            [Parameters<typeof port.command>[1], Record<string, unknown>]
          >)
        : []),
      ['set-cli', { scope: 'task', scopeId: taskId, adapter: 'claude', timing: 'now' }],
      ...(model
        ? ([
            [
              'set-model',
              {
                scope: 'task',
                scopeId: taskId,
                model,
                effort,
                timing: 'now',
              },
            ],
          ] as Array<[Parameters<typeof port.command>[1], Record<string, unknown>]>)
        : []),
      ['launch', {}],
    ];
    for (const [kind, fields] of commands) {
      const out = await port.command(taskId, kind, fields);
      if (out.status !== 'applied') {
        this.cancel();
        throw new Error(
          `core chat: ${kind} refused (${out.code ?? 'rejected'}): ${out.reason ?? ''}`.trim(),
        );
      }
    }
    const { stepId, sessionId } = await this.waitStep(taskId);
    // Новый разговор зовётся первым сеансом ядра: переходник отдаёт его claude как `--session-id`.
    const conversationId = conversation ?? sessionId;
    this.stepId = stepId;
    this.conversationId = conversationId;
    book.set(conversationId, { taskId, stepId });
    if (this.stopped) {
      this.cancel();
      return null;
    }
    return { taskId, stepId, sessionId, from: 0, conversationId };
  }

  /** Шаг `chat` и его первый сеанс; шаг кончился без сеанса — отказ с причиной ядра. */
  private async waitStep(
    taskId: string,
    after?: string,
  ): Promise<{ stepId: string; sessionId: string }> {
    const { port } = this.deps;
    const deadline = this.now + (this.deps.waitMs ?? WAIT_MS);
    while (!this.abort.signal.aborted && this.now < deadline) {
      const view = await port.view(taskId).catch(() => null);
      const step = view ? chatStep(view, this.stepId) : undefined;
      if (view && step) {
        const session = sessionAfter(view, step.stepId, after);
        if (session) {
          return { stepId: step.stepId, sessionId: session.sessionId };
        }
        if (stepClosed(step.state)) {
          throw new Error(
            `core chat: the chat step ended without a session (${step.outcome ?? step.state}): ${step.reason ?? ''}`.trim(),
          );
        }
      }
      if (view?.ended) throw new Error(`core chat: the core task ended (${view.ended})`);
      await sleep(this.deps.pollMs ?? POLL_MS, this.abort.signal);
    }
    if (this.abort.signal.aborted) throw new Error('core chat: stopped');
    throw new Error('core chat: the core opened no session for the chat step');
  }

  /** Вид сеанса до конца хода; сеанс кончился раньше — ядро продолжает шаг новым сеансом. */
  private async readTurn(
    placed: Placed,
    onEvent: (event: ChatEvent) => void,
    startedAt: number,
  ): Promise<void> {
    const { port } = this.deps;
    let sessionId = placed.sessionId;
    let from = placed.from;
    const finish = (): void => {
      this.finished = true;
      onEvent({
        kind: 'done',
        costUsd: 0,
        durationMs: Math.max(0, this.now - startedAt),
        sessionId: placed.conversationId,
      });
    };
    for (;;) {
      const seen = new Set<string>();
      const turn = new AbortController();
      const relay = (): void => turn.abort();
      this.abort.signal.addEventListener('abort', relay, { once: true });
      this.release = relay;
      try {
        for await (const page of port.follow(placed.taskId, sessionId, from, turn.signal)) {
          const keys = sessionEventKeys(page.events);
          for (const [i, event] of page.events.entries()) {
            const key = keys[i]!;
            if (seen.has(key)) continue;
            seen.add(key);
            if (event.kind === 'user-text') {
              this.held = false;
              this.delivered((event.data as { text?: unknown })?.text);
            }
            const out = translate(event, this.now);
            if (out.kind === 'event') onEvent(out.event);
            if (out.kind === 'turn-end') {
              // Слова CLI — сообщением ошибки: по ним лента ставит код (переполнение, старый CLI) и
              // повтор; общая строка — только когда CLI ничего не сказал.
              if (out.isError) onEvent({ kind: 'error', message: out.text ?? TURN_ERROR_TEXT });
              // Слово «на ходу» ещё впереди — его ход идёт этим же прогоном.
              this.held = this.owed.length > 0;
              if (!this.held) return finish();
            }
          }
          if (page.done) break;
        }
      } catch (error) {
        // Поток оборван отказом ядра в придержанном слове — ход уже кончился, ждать нечего.
        if (!(turn.signal.aborted && !this.abort.signal.aborted)) throw error;
      } finally {
        this.abort.signal.removeEventListener('abort', relay);
        this.release = null;
      }
      if (this.stopped) return;
      if (this.held && this.owed.length === 0) return finish();
      const next = await this.waitStep(placed.taskId, sessionId).catch((error: unknown) => {
        throw new Error(
          `core chat: the core session ended before the turn finished (${String(error instanceof Error ? error.message : error)})`,
        );
      });
      sessionId = next.sessionId;
      from = 0;
    }
  }

  /**
   * Журнал задачи этого хода. Ключ репозитория (`unit.created`) уходит браузеру событием
   * `coreTask` — автоподтверждение выдаёт грант своей командой. Вопросы права этого шага
   * (`human.asked`, источник `permit`) — карточкой в чате через брокер панели; отвечает на них
   * браузер командой ядра с числом страницы (ответ `answer` — human-strict, 06 §Authority), а
   * сервер ответа ядру не шлёт никогда: его ядро отвергло бы `signature-required`. Ответ, записанный
   * ядром (`human.answered`), снимает карточку. Вопрос, уже решённый в ядре (повтор журнала с
   * начала), карточки не получает.
   */
  private watchPermits(
    placed: Placed,
    options: RunOptions,
    onEvent: (event: ChatEvent) => void,
  ): void {
    const { port } = this.deps;
    const runId = options.permissionPrompt?.runId;
    const facts: PermitFacts = {
      units: new Map(),
      stepUnits: new Map(),
      targets: new Map(),
      lastTarget: new Map(),
    };
    let announced = false;
    void (async () => {
      for await (const line of port.taskEvents(placed.taskId, this.abort.signal)) {
        noteFact(facts, line);
        if (!announced && line.kind === 'unit.created') {
          const project = repoKeyOf(facts, placed.stepId) ?? [...facts.units.values()][0];
          if (project) {
            announced = true;
            onEvent({ kind: 'coreTask', taskId: placed.taskId, project });
          }
        }
        const answered = answeredAsk(line);
        if (answered) {
          this.settleCard(answered.askId, answered.answer, runId, onEvent);
          continue;
        }
        const ask = permitAsk(line, placed.stepId);
        if (!ask || this.asked.has(ask.askId)) continue;
        this.asked.add(ask.askId);
        const view = await port.view(placed.taskId).catch(() => null);
        const known = view?.asks.find((a) => a.askId === ask.askId);
        if (!known || askClosed(known.state)) continue;
        this.showCard(placed, ask, facts, options.cwd, runId, onEvent);
      }
    })().catch(() => undefined);
  }

  /** Вопросы права, чья карточка показана и ещё не снята ответом ядра. */
  private readonly cards = new Set<string>();

  private showCard(
    placed: Placed,
    ask: PermitAsk,
    facts: PermitFacts,
    cwd: string,
    runId: string | undefined,
    onEvent: (event: ChatEvent) => void,
  ): void {
    const project = repoKeyOf(facts, placed.stepId);
    const target = ask.cause !== null ? facts.targets.get(ask.cause) : undefined;
    // Маска — от корня копии (cwd прогона), не от ключа репозитория: ключ — имя, а не путь.
    const glob = target ? grantGlob(target, cwd) : undefined;
    // Поля ядра — и окну, и брокеру: из брокера сводка ожиданий отдаёт их «Вопросам» телефона,
    // а телефон по ним отвечает ядру подписанными командами (G9).
    const card = {
      toolName: CORE_PERMIT_TOOL,
      input: { question: ask.question },
      toolUseId: ask.askId,
      core: {
        taskId: placed.taskId,
        askId: ask.askId,
        point: ask.point,
        options: ask.options,
        project,
        globs: glob ? [glob] : [],
      },
    };
    this.cards.add(ask.askId);
    onEvent({ kind: 'permission', ...card });
    const { desk } = this.deps;
    if (!desk || !runId) return;
    // Брокер держит карточку ради сводки ожиданий и статуса; снимает её ответ ядра (`settle`).
    // Ответ брокера без ответа ядра — срок брокера или конец прогона: карточка «истекла», а вопрос
    // ядра остаётся ждать человека в его ленте.
    void desk.request(runId, card).then((reply) => {
      if (!this.cards.delete(ask.askId)) return;
      onEvent({
        kind: 'permissionResolved',
        toolUseId: ask.askId,
        behavior: reply.behavior,
        ...(reply.expired ? { expired: true as const } : {}),
      });
    });
  }

  private settleCard(
    askId: string,
    answer: string,
    runId: string | undefined,
    onEvent: (event: ChatEvent) => void,
  ): void {
    if (!this.cards.delete(askId)) return;
    const behavior = answer === 'grant' || answer === 'allow' ? 'allow' : 'deny';
    onEvent({ kind: 'permissionResolved', toolUseId: askId, behavior });
    if (runId) this.deps.desk?.settle(runId, askId, { behavior });
  }
}

/** Имя «инструмента» карточки вопроса права ядра — одно на панель, окно и Telegram (контракты). */
export { CORE_PERMIT_TOOL };

interface PermitAsk {
  askId: string;
  point: number;
  question: string;
  options: string[];
  /** Строка решения права, поднявшего вопрос (`cause`): там цель отказа. */
  cause: number | null;
}

/** Факты журнала для карточки: репозиторий единицы шага и цель каждого отказа права. */
interface PermitFacts {
  units: Map<string, string>;
  stepUnits: Map<string, string>;
  targets: Map<number, string>;
  /** Цель последнего отказа права по сессии: решение пункта человека за ним цели не несёт. */
  lastTarget: Map<string, string>;
}

function noteFact(facts: PermitFacts, line: JournalLine): void {
  const d = line.data as Record<string, unknown>;
  const session = line.sessionId ?? line.stepId ?? '';
  if (line.kind === 'unit.created' && typeof d.unitId === 'string') {
    if (typeof d.repoKey === 'string') facts.units.set(d.unitId, d.repoKey);
  } else if (line.kind === 'step.started' && typeof d.stepId === 'string') {
    if (typeof d.unitId === 'string') facts.stepUnits.set(d.stepId, d.unitId);
  } else if (line.kind === 'decision' && d.class === 'permit') {
    const output = d.output as { target?: unknown } | undefined;
    if (typeof output?.target !== 'string') return;
    facts.targets.set(line.seq, output.target);
    facts.lastTarget.set(session, output.target);
  } else if (line.kind === 'decision' && d.class === 'human-point') {
    // Ядро (`conductor/human/raise.ts`) пишет за отказом права своё решение пункта, и `cause`
    // вопроса указывает на него — цель берётся у отказа той же сессии прямо перед ним.
    const output = d.output as { source?: unknown } | undefined;
    const target = facts.lastTarget.get(session);
    if (output?.source === 'permit' && target !== undefined) facts.targets.set(line.seq, target);
  }
}

function repoKeyOf(facts: PermitFacts, stepId: string): string | null {
  const unitId = facts.stepUnits.get(stepId);
  return (unitId && facts.units.get(unitId)) || null;
}

/**
 * Цель отказа (путь как его назвал CLI, обычно полный) → маска гранта от корня репозитория.
 * Ядро сверяет гранты по пути от корня копии; полный путь маской не совпал бы ни с чем — поэтому
 * полный путь вне корня даёт `null` (гранта собрать не из чего), а не бесполезную маску.
 */
export function grantGlob(
  target: string,
  root: string,
  onDisk: (path: string) => string = onDiskPath,
): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const inside = (t: string, r: string) =>
    r && t.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? t.slice(r.length + 1) : null;
  const t = norm(target);
  const literal = inside(t, norm(root));
  if (literal !== null) return literal;
  if (!/^([a-z]:)?\//i.test(t)) return t.replace(/^\.\//, '');
  // Одна папка — две записи: Windows отдаёт TEMP короткими именами 8.3 (`RUSYAN~1`), CLI называет
  // путь длинными. Сверка — по форме на диске, как у судьи права ядра (`pathKey`).
  return inside(norm(onDisk(target)), norm(onDisk(root)));
}

/**
 * Путь в форме тома: короткие имена 8.3 и регистр — как на диске. Несуществующий хвост (файл, который
 * CLI ещё только пишет) дописывается как есть к ближайшему существующему предку.
 */
export function onDiskPath(path: string): string {
  const tail: string[] = [];
  let head = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

function permitAsk(line: JournalLine, stepId: string): PermitAsk | undefined {
  if (line.kind !== 'human.asked' || line.stepId !== stepId) return undefined;
  const data = line.data as {
    askId?: unknown;
    point?: unknown;
    source?: unknown;
    question?: unknown;
    options?: unknown;
  };
  if (data.source !== 'permit' || typeof data.askId !== 'string') return undefined;
  return {
    askId: data.askId,
    point: typeof data.point === 'number' ? data.point : 0,
    question: typeof data.question === 'string' ? data.question : '',
    options: Array.isArray(data.options)
      ? data.options.filter((o): o is string => typeof o === 'string')
      : [],
    cause: typeof line.cause === 'number' ? line.cause : null,
  };
}

function answeredAsk(line: JournalLine): { askId: string; answer: string } | undefined {
  if (line.kind !== 'human.answered') return undefined;
  const d = line.data as { askId?: unknown; answer?: unknown };
  if (typeof d.askId !== 'string') return undefined;
  return { askId: d.askId, answer: typeof d.answer === 'string' ? d.answer : '' };
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

/**
 * Сеанс шага, с которого читать: первый (ход нового чата начинается в нём, даже если ядро успело
 * открыть следующий) или тот, что идёт за прочитанным `after`.
 */
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

function latestSession(view: TaskView, stepId: string): TaskView['sessions'][number] | undefined {
  return view.sessions
    .filter((s) => s.stepId === stepId)
    .sort((a, b) => b.startedSeq - a.startedSeq)[0];
}
