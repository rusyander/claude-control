import { randomUUID } from 'node:crypto';
import {
  buildTreeResumePrompt,
  type ChatAwaitingView,
  type ChatTreeAsk,
  type ChatTreeNode,
  type ChatTreeNodeStatus,
  type ChatTreePaused,
  type ChatTreeResumed,
  type ChatTreeView,
  type SplitReviewView,
} from '@agentdeck/contracts/chat-handoff';
import type {
  ChatLink,
  PausedTreeChat,
  PendingTreeStart,
  TreePauseRecord,
} from '../../../lib/app-store/app-store.types.ts';
import { linkIdentity } from '../../../lib/app-store/chat-links.ts';
import type {
  ChatRunRegistry,
  RunMeta,
  RunSnapshot,
  StopOutcome,
} from '../ChatRunRegistry/ChatRunRegistry.ts';
import { withProcessSnapshot } from '../../../lib/process-tree/process-tree.ts';
import type { RunOptions } from '../ChatRunner/ChatRunner.ts';
import type { AutoApproveState } from '../ChatSession/ChatSession.ts';

/**
 * Пауза дерева разговоров: «Остановить всё» у родителя.
 *
 * Разделение заводит ребёнка на группу, конвейер — до трёх звеньев на ребёнка,
 * продолжение в чистой сессии — ещё по разговору на каждый закрытый этап.
 * Остановить это по одному нельзя: пока человек гасит третий чат, у первого
 * уже стартовало ревью. Поэтому пауза — состояние ДЕРЕВА, а не прогонов:
 *
 * - идущие прогоны останавливаются, а всё, чем их перезапустить (параметры,
 *   сессия, права), ложится в запись;
 * - автостарты панели — продолжения, звенья, дети разделения — в стоящем
 *   дереве не запускаются, а встают в очередь записи (см. `TreeStartGate`);
 * - «Продолжить всё» перезапускает остановленное В ТЕХ ЖЕ сессиях (`--resume`)
 *   и выпускает очередь по порядку.
 *
 * Запись живёт в хранилище панели, а не в памяти: паузу нажимают на ночь, и
 * перезапуск стенда за ночь не должен ни потерять остановленное, ни молча
 * расконсервировать очередь.
 */

export type TreeStartKind = PendingTreeStart['kind'];

/** Обработчик отложившего — его забота: сбой в нём не останавливает выпуск очереди. */
function quietly(run: () => void): void {
  try {
    run();
  } catch {
    // Остальные старты дерева от чужого сбоя не зависят.
  }
}

/**
 * Что отложивший старт хочет сделать, когда «Продолжить всё» его выпустит.
 * Без этого продолжение группы «по плану» (`group-wait.ts`) выходило из очереди
 * чужим: слушатель стартов принимал его за слово человека и обнулял счёт
 * продолжений, а отказ реестра в старте никто не проводил — вопрос группы не
 * доходил до человека.
 */
export interface TreeStartHooks {
  /** Перед запуском из очереди. */
  before?(): void;
  /** После запуска: `started` — реестр принял ход. */
  after?(started: boolean): void;
}

/** Воротца перед автостартом: `true` — дерево стоит, старт отложен в очередь. */
export interface TreeStartGate {
  defer(
    kind: TreeStartKind,
    chatId: string,
    options: RunOptions,
    meta: RunMeta,
    hooks?: TreeStartHooks,
  ): boolean;
  /** Стоит ли дерево чата — старт, отложенный до готового задания, ляжет в очередь. */
  paused?(chatId: string): boolean;
}

export interface TreePauseStore {
  get(root: string): TreePauseRecord | undefined;
  all(): Record<string, TreePauseRecord>;
  set(record: TreePauseRecord): void;
  clear(root: string): void;
}

export interface TreePauseDeps {
  links: () => Record<string, ChatLink>;
  runs: Pick<ChatRunRegistry, 'describe' | 'stop' | 'start' | 'isRunning'>;
  store: TreePauseStore;
  /**
   * Тумблер автоподтверждения остановленного прогона: снимается при паузе и
   * взводится обратно при продолжении. Без этого продолженный ночью ребёнок
   * встал бы на первом же инструменте — ровно то, от чего пауза и спасает.
   */
  autoApprove?: {
    snapshot(chatId: string): AutoApproveState | undefined;
    arm(chatId: string, state: AutoApproveState): void;
  };
  /**
   * Ревью по ссылке (Т7) глазами узла дерева: карточку решения хаб и чат
   * ребёнка берут отсюда. Нет — ревью по ссылкам в этой сборке нет, и узлы
   * выглядят как раньше.
   */
  reviewView?: (link: ChatLink) => SplitReviewView | undefined;
  /**
   * Чем разговор с этими ключами стоит на человеке (WP9c): серверная запись
   * вопросов и запросов прав. Нет — узлы без них, как раньше.
   */
  asksOf?: (keys: readonly string[]) => ChatTreeAsk[];
  /**
   * Группа разделения между ходами с идущим фоном (23.10, N1a): хода нет, и
   * остановка прогонов её не видит, а конец фона будил CLI в стоящем дереве.
   * `snapshot` — чем её продолжить, `close` — погасить процесс. Нет — как раньше.
   */
  idle?: {
    snapshot(chatId: string): RunSnapshot | undefined;
    close(chatId: string): StopOutcome;
  };
  /** После паузы — по ключам снятых разговоров (добор процессов копий групп). */
  afterPause?: (keys: readonly string[]) => void;
  /**
   * Мост прав к ЭТОЙ панели для разговора `runId`. Сохранённые параметры
   * несут мост той жизни, в которой их сняли: у сессии, подхваченной из
   * журнала после перезапуска, адрес пуст (ключ ход берёт из файла), и
   * продолжение с ним отказывало каждому запросу прав «no connection to the
   * AgentDeck panel». Поэтому мост собирается заново при каждом запуске из
   * записи — как у продолжения в чистой сессии. Нет — параметры как сохранены.
   */
  bridge?: (runId: string) => NonNullable<RunOptions['permissionPrompt']>;
  now?: () => Date;
}

/**
 * Корень дерева, в котором живёт разговор: подъём по `parentChatId` до
 * разговора без связи. Зациклившиеся связи (их не бывает, но хранилище
 * правят руками) останавливают подъём на первом повторе.
 */
export function rootOf(links: Record<string, ChatLink>, chatId: string): string {
  let current = chatId;
  const seen = new Set<string>([current]);
  for (;;) {
    const parent = links[current]?.parentChatId;
    if (!parent || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
}

/**
 * Все ключи потомков корня, в ширину. У одного разговора ключей бывает два
 * (временный `new-…` и настоящий `sessionId`, связь копируется на оба), и дети
 * могут ссылаться на любой из них — поэтому обход идёт по КЛЮЧАМ связей, а
 * склейка «два ключа — один разговор» остаётся тем, кто смотрит на прогоны.
 */
export function collectTree(links: Record<string, ChatLink>, root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift() as string;
    for (const [key, link] of Object.entries(links)) {
      if (link.parentChatId !== parent || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
      queue.push(key);
    }
  }
  return out;
}

/**
 * Ключи всех разговоров стоящих деревьев — для фишки «на паузе» в списке.
 * Корень, его потомки по связям, остановленные прогоны и их сессии: список
 * знает разговор по `sessionId`, а запись — по ключу прогона, и совпадать они
 * не обязаны.
 */
export function pausedChatIds(
  records: Record<string, TreePauseRecord>,
  links: Record<string, ChatLink>,
): Set<string> {
  const out = new Set<string>();
  for (const record of Object.values(records)) {
    out.add(record.root);
    for (const key of collectTree(links, record.root)) out.add(key);
    for (const [key, chat] of Object.entries(record.chats)) {
      out.add(key);
      if (chat.sessionId) out.add(chat.sessionId);
    }
    for (const pending of record.pendingStarts) out.add(pending.chatId);
  }
  return out;
}

export class TreePause implements TreeStartGate {
  private readonly deps: TreePauseDeps;
  /**
   * Обработчики отложенных стартов — только в памяти: это замыкания. Ключ —
   * случайный, а не счётчик: очередь в хранилище переживает перезапуск, и
   * номер старой жизни совпал бы с номером новой — сработал бы чужой обработчик.
   */
  private readonly hooks = new Map<string, TreeStartHooks>();

  constructor(deps: TreePauseDeps) {
    this.deps = deps;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** Всё, чем перезапустить разговор: параметры, сессия, права. */
  private snapshotOf(run: RunSnapshot): PausedTreeChat {
    const autoApprove = this.deps.autoApprove?.snapshot(run.key);
    return {
      cwd: run.options.cwd,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      options: withoutRoute(run.options) as unknown as Record<string, unknown>,
      meta: run.meta as unknown as Record<string, unknown>,
      ...(autoApprove ? { autoApprove: { ...autoApprove } } : {}),
      pausedAt: this.now(),
    };
  }

  /** Ждёт ли разговор дерева человека — метка «ждёт вас» в списке чатов. */
  awaitsHuman(chatId: string): boolean {
    return (this.deps.asksOf?.([chatId]) ?? []).length > 0;
  }

  /**
   * Все ждущие человека разговоры деревьев — для сигнала вкладке. Разговор,
   * заведённый панелью, связан дважды (временный `new-…` и настоящий ключ), а
   * вопрос у него один: считается один раз, под настоящим ключом.
   */
  awaiting(): ChatAwaitingView['chats'] {
    const asksOf = this.deps.asksOf;
    if (!asksOf) return [];
    const seen = new Map<string, ChatAwaitingView['chats'][number]>();
    for (const [chatId, link] of Object.entries(this.deps.links())) {
      if (!link.parentChatId) continue;
      const ask = asksOf([chatId])[0];
      if (!ask) continue;
      const key = `${ask.runId}:${ask.toolUseId ?? ask.askedAt}`;
      const known = seen.get(key);
      if (known && !known.chatId.startsWith('new-')) continue;
      seen.set(key, {
        chatId,
        parentChatId: link.parentChatId,
        kind: ask.kind,
        askedAt: ask.askedAt,
      });
    }
    return [...seen.values()];
  }

  /** Стоит ли дерево, в котором живёт разговор (по любому его ключу). */
  isPaused(chatId: string): boolean {
    return this.deps.store.get(rootOf(this.deps.links(), chatId)) !== undefined;
  }

  /**
   * Остановить дерево целиком. Идемпотентно: повторное нажатие доостанавливает
   * то, что успело запуститься (человек мог написать ребёнку вручную), и
   * дописывает это в ту же запись.
   */
  pause(chatId: string): ChatTreePaused {
    const links = this.deps.links();
    const root = rootOf(links, chatId);
    const existing = this.deps.store.get(root);
    const record: TreePauseRecord = existing ?? {
      root,
      at: this.now(),
      chats: {},
      pendingStarts: [],
    };

    let stopped = 0;
    let unconfirmed = 0;
    const seen = new Set<string>();
    const halted: string[] = [];
    const keys = [root, ...collectTree(links, root)];
    /**
     * Снимок — до остановки: реестр забывает прогон сразу. Процесс жив и не снят
     * — номер нечем проверить (F-145). В запись паузы его не кладём: «Продолжить»
     * подняло бы по нему вторую копию той же сессии рядом с живой. Прогон доходит
     * свой ход; следующие старты дерева пауза всё равно откладывает, а человек
     * узнаёт число из ответа.
     */
    const hold = (run: RunSnapshot, stop: () => StopOutcome): void => {
      const snapshot = this.snapshotOf(run);
      if (stop() === 'unconfirmed') {
        unconfirmed += 1;
        return;
      }
      record.chats[run.key] = snapshot;
      halted.push(run.key);
      stopped += 1;
    };
    // Один снимок процессов на всё дерево: N сессий × ~0,8 с снимка Windows.
    withProcessSnapshot(() => {
      for (const key of keys) {
        const run = this.deps.runs.describe(key);
        if (!run || seen.has(run.key) || run.status !== 'running') continue;
        seen.add(run.key);
        hold(run, () => this.deps.runs.stop(run.key));
      }
      // Группы разделения между ходами — как пауза одной группы (N1a, 23.10):
      // процесс с фоном гасится сразу, а «Продолжить всё» продолжает его той же
      // сессией. Прочие разговоры дерева без хода сами не просыпаются.
      const idle = this.deps.idle;
      if (!idle) return;
      for (const key of keys) {
        if (links[key]?.groupIndex === undefined) continue;
        const run = idle.snapshot(key);
        if (!run || seen.has(run.key) || record.chats[run.key]) continue;
        seen.add(run.key);
        hold(run, () => idle.close(key));
      }
    });

    this.deps.store.set(record);
    // Добор — по снятым И по всем группам дерева (F-106): группа между ходами без фона
    // процесса не держит, но её копия может держать оставленный сервер или наблюдатель.
    const sweep = [
      ...new Set([...halted, ...keys.filter((key) => links[key]?.groupIndex !== undefined)]),
    ];
    if (sweep.length > 0) {
      try {
        this.deps.afterPause?.(sweep);
      } catch {
        // Добор после паузы — страховка: ответ человеку от него не зависит.
      }
    }
    return {
      root,
      stopped,
      unconfirmed,
      chats: Object.keys(record.chats).length,
      alreadyPaused: existing !== undefined,
    };
  }

  /**
   * Продолжить дерево: остановленное — в тех же сессиях, отложенное — по
   * порядку. Запись снимается ДО запусков, иначе воротца отложили бы их же.
   */
  resume(chatId: string): ChatTreeResumed {
    const root = rootOf(this.deps.links(), chatId);
    const record = this.deps.store.get(root);
    if (!record) return { root, wasPaused: false, resumed: 0, flushed: 0 };
    this.deps.store.clear(root);

    let resumed = 0;
    for (const [key, chat] of Object.entries(record.chats)) {
      if (this.deps.runs.isRunning(key)) continue;
      const saved = chat.options as unknown as RunOptions;
      const sessionId = chat.sessionId ?? saved.sessionId;
      // Сессия известна — продолжаем её одной фразой о том, что случилось.
      // Неизвестна — прогон остановили до первого ответа CLI, продолжать нечего:
      // задание идёт заново, как было.
      const options: RunOptions = sessionId
        ? { ...saved, sessionId, prompt: buildTreeResumePrompt() }
        : { ...saved };
      delete options.fork;
      this.liveBridge(options, key);
      const meta: RunMeta = {
        ...(chat.meta as unknown as RunMeta),
        ...(sessionId ? { sessionId } : {}),
      };
      if (chat.autoApprove) this.deps.autoApprove?.arm(key, chat.autoApprove);
      if (this.deps.runs.start(key, options, meta)) resumed += 1;
    }

    let flushed = 0;
    for (const pending of record.pendingStarts) {
      const options = { ...(pending.options as unknown as RunOptions) };
      // Очередь переживает перезапуск в хранилище — мост в ней той жизни.
      this.liveBridge(options, options.permissionPrompt?.runId ?? pending.chatId);
      const hooks = pending.hook ? this.hooks.get(pending.hook) : undefined;
      if (pending.hook) this.hooks.delete(pending.hook);
      quietly(() => hooks?.before?.());
      let started = false;
      try {
        started = this.deps.runs.start(pending.chatId, options, pending.meta as unknown as RunMeta);
      } finally {
        quietly(() => hooks?.after?.(started));
      }
      if (started) flushed += 1;
    }
    return { root, wasPaused: true, resumed, flushed };
  }

  /** Мост прав — к этой панели; запуск без моста (CLI без панели) остаётся без него. */
  private liveBridge(options: RunOptions, runId: string): void {
    if (options.permissionPrompt && this.deps.bridge) {
      options.permissionPrompt = this.deps.bridge(runId);
    }
  }

  paused(chatId: string): boolean {
    return Boolean(this.deps.store.get(rootOf(this.deps.links(), chatId)));
  }

  defer(
    kind: TreeStartKind,
    chatId: string,
    options: RunOptions,
    meta: RunMeta,
    hooks?: TreeStartHooks,
  ): boolean {
    const root = rootOf(this.deps.links(), chatId);
    const record = this.deps.store.get(root);
    if (!record) return false;
    const hook = hooks ? randomUUID() : undefined;
    if (hook && hooks) this.hooks.set(hook, hooks);
    record.pendingStarts.push({
      kind,
      chatId,
      options: withoutRoute(options) as unknown as Record<string, unknown>,
      meta: meta as unknown as Record<string, unknown>,
      at: this.now(),
      ...(hook ? { hook } : {}),
    });
    this.deps.store.set(record);
    return true;
  }

  /** Дерево для пульта: узлы со склейкой ключей одного разговора, кто идёт, стоит ли всё. */
  view(chatId: string): ChatTreeView {
    const links = this.deps.links();
    const root = rootOf(links, chatId);
    const record = this.deps.store.get(root);

    // Два ключа одной связи — один разговор: узнаём по каноническому ключу
    // разговора (Д11), а не по содержимому — оно расходится с первой записью
    // поля под одним ключом, и узел раздваивался. Реестр прогонов здесь не
    // помощник: он помнит лишь живые и недавно ушедшие прогоны.
    const byIdentity = new Map<string, ChatTreeNode>();
    for (const key of collectTree(links, root)) {
      const link = links[key] as ChatLink;
      const identity = linkIdentity(link);
      const running = this.deps.runs.isRunning(key);
      const node = byIdentity.get(identity);
      if (node) {
        node.aliases.push(key);
        // Настоящий ключ сессии вытесняет временный: под ним разговор в списке.
        if (node.chatId.startsWith('new-') && !key.startsWith('new-')) {
          node.aliases.push(node.chatId);
          node.chatId = key;
          node.aliases = node.aliases.filter((alias) => alias !== key);
        }
        node.running = node.running || running;
        continue;
      }
      byIdentity.set(identity, {
        chatId: key,
        aliases: [],
        parentChatId: link.parentChatId,
        ...(link.title ? { title: link.title } : {}),
        ...(link.branch ? { branch: link.branch } : {}),
        ...(typeof link.groupIndex === 'number' ? { groupIndex: link.groupIndex } : {}),
        ...(link.stage ? { stage: link.stage } : {}),
        running,
        ...(() => {
          const view = this.deps.reviewView?.(link);
          return view ? { review: view } : {};
        })(),
      });
    }
    const nodes = [...byIdentity.values()];
    const parked = record ? pausedChatIds({ [root]: record }, {}) : new Set<string>();
    for (const node of nodes) {
      const keys = [node.chatId, ...node.aliases];
      const asks = this.deps.asksOf?.(keys) ?? [];
      if (asks.length > 0) node.asks = asks;
      node.status = nodeStatus(
        node.running,
        asks,
        keys.some((key) => parked.has(key)),
      );
    }
    const rootRunning = this.deps.runs.isRunning(root);
    return {
      root,
      ...(record
        ? {
            paused: {
              at: record.at,
              chats: Object.keys(record.chats).length,
              pending: record.pendingStarts.length,
            },
          }
        : {}),
      running: nodes.filter((node) => node.running).length + (rootRunning ? 1 : 0),
      nodes,
    };
  }
}

/**
 * Состояние узла по фактам (журнал 89). Запрос прав держит прогон на месте —
 * это «ждёт», даже пока процесс жив; вопрос посреди хода — ещё нет: агент
 * договаривает ход и только потом встаёт.
 */
function nodeStatus(
  running: boolean,
  asks: readonly ChatTreeAsk[],
  parked: boolean,
): ChatTreeNodeStatus {
  if (asks.some((ask) => ask.kind === 'permission')) return 'waiting';
  if (running) return 'running';
  if (asks.length > 0) return 'waiting';
  return parked ? 'paused' : 'idle';
}

/**
 * Параметры прогона без маршрута контура — то, что ложится в запись паузы.
 *
 * Адрес шлюза, промпт контура и флаги слоёв реестр решает на КАЖДОМ старте
 * (`ChatRunRegistry.start`) и сохранённые не читает никогда. Записанные в
 * `state.json`, они были бы мёртвым грузом: адрес, имя модели и целый системный
 * промпт в файле состояния панели, которые при продолжении всё равно затрутся
 * (ревью Т3, MINOR 15).
 */
function withoutRoute(options: RunOptions): RunOptions {
  const {
    platformEnv: _env,
    platformSystemPrompt: _prompt,
    platformArgs: _args,
    platformDropAppend: _drop,
    platformAppend: _append,
    platformMcp: _mcp,
    ...rest
  } = options;
  return rest;
}
