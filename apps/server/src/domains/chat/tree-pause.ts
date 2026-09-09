import {
  buildTreeResumePrompt,
  type ChatTreeNode,
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
} from '../../lib/app-store/app-store.types.ts';
import type { ChatRunRegistry, RunMeta } from './ChatRunRegistry.ts';
import type { RunOptions } from './ChatRunner.ts';
import type { AutoApproveState } from './ChatSession.ts';

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

/** Воротца перед автостартом: `true` — дерево стоит, старт отложен в очередь. */
export interface TreeStartGate {
  defer(kind: TreeStartKind, chatId: string, options: RunOptions, meta: RunMeta): boolean;
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

  constructor(deps: TreePauseDeps) {
    this.deps = deps;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
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
    const seen = new Set<string>();
    for (const key of [root, ...collectTree(links, root)]) {
      const run = this.deps.runs.describe(key);
      if (!run || seen.has(run.key) || run.status !== 'running') continue;
      seen.add(run.key);
      const autoApprove = this.deps.autoApprove?.snapshot(run.key);
      const snapshot: PausedTreeChat = {
        cwd: run.options.cwd,
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        options: run.options as unknown as Record<string, unknown>,
        meta: run.meta as unknown as Record<string, unknown>,
        ...(autoApprove ? { autoApprove: { ...autoApprove } } : {}),
        pausedAt: this.now(),
      };
      // Остановка — ПОСЛЕ снимка: реестр забывает прогон сразу.
      this.deps.runs.stop(run.key);
      record.chats[run.key] = snapshot;
      stopped += 1;
    }

    this.deps.store.set(record);
    return {
      root,
      stopped,
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
      const meta: RunMeta = {
        ...(chat.meta as unknown as RunMeta),
        ...(sessionId ? { sessionId } : {}),
      };
      if (chat.autoApprove) this.deps.autoApprove?.arm(key, chat.autoApprove);
      if (this.deps.runs.start(key, options, meta)) resumed += 1;
    }

    let flushed = 0;
    for (const pending of record.pendingStarts) {
      if (
        this.deps.runs.start(
          pending.chatId,
          pending.options as unknown as RunOptions,
          pending.meta as unknown as RunMeta,
        )
      ) {
        flushed += 1;
      }
    }
    return { root, wasPaused: true, resumed, flushed };
  }

  defer(kind: TreeStartKind, chatId: string, options: RunOptions, meta: RunMeta): boolean {
    const root = rootOf(this.deps.links(), chatId);
    const record = this.deps.store.get(root);
    if (!record) return false;
    record.pendingStarts.push({
      kind,
      chatId,
      options: options as unknown as Record<string, unknown>,
      meta: meta as unknown as Record<string, unknown>,
      at: this.now(),
    });
    this.deps.store.set(record);
    return true;
  }

  /** Дерево для пульта: узлы со склейкой ключей одного разговора, кто идёт, стоит ли всё. */
  view(chatId: string): ChatTreeView {
    const links = this.deps.links();
    const root = rootOf(links, chatId);
    const record = this.deps.store.get(root);

    // Два ключа одной связи — один разговор: связь копируется на `sessionId`
    // как есть, и одинаковое содержимое надёжнее любого реестра, который
    // помнит лишь живые и недавно ушедшие прогоны.
    const byIdentity = new Map<string, ChatTreeNode>();
    for (const key of collectTree(links, root)) {
      const link = links[key] as ChatLink;
      const identity = JSON.stringify(link);
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
        ...(link.stage ? { stage: link.stage } : {}),
        running,
        ...(() => {
          const view = this.deps.reviewView?.(link);
          return view ? { review: view } : {};
        })(),
      });
    }
    const nodes = [...byIdentity.values()];
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
