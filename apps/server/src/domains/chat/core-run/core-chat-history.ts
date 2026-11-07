import type {
  ChatBlock,
  ChatMessage,
  ChatMessagesPage,
  ChatSummary,
  MessageUsage,
} from '@agentdeck/contracts';
import {
  humanTextOf,
  sentAtOf,
  type SessionStreamEvent,
} from '@agentdeck/contracts/core/session-stream';
import { isSandboxPath } from '../ChatArtifacts/ChatArtifacts.ts';
import { cutTitle } from '../ChatHistory/ChatHistory.ts';
import { withoutLinks } from '../ChatRecords/ChatRecords.ts';
import { withoutInitiativeTail, withoutPanelPreamble } from '../panel-preamble.ts';
import { layoutForCwd } from '../../project-git/copy-readiness.ts';
import {
  coreChatHistoryEntries,
  coreChatHistoryEntry,
  type CoreChatHistoryEntry,
} from './core-chat-book.ts';
import type { CoreChatPort } from './core-run.types.ts';

/**
 * История разговора не-Claude CLI (этап 11, волна 3): лента, список чатов и отпечаток для опроса —
 * из видов сеансов ядра (`GET /v1/tasks/:id/sessions/:sid/stream?from=0`) тех задач, что вели
 * разговор по книге (`core-chat-book.ts`). Транскрипта чужого CLI панель не читает: формат у
 * каждого свой, а вид сеанса — нормализатор самого переходника ядра, один на любой CLI. Своей
 * копии разговора здесь нет: в памяти только свёртка задачи, которая уже кончилась (её вид больше
 * не меняется), — ключом её число журнала.
 *
 * Время хода — стена отправки (`sentAt` хода человека, `core-io.jsonl` `wall`): вид сеанса
 * времени строк не несёт. Ответ получает время своего хода — по нему вкладка отличает прошлые
 * ответы (меньше начала идущего прогона) от ответа идущего хода (`withoutLiveTurn`). Запись без
 * стены (прежняя) — время предыдущего хода, а самый первый — начало эпохи.
 */

type HistoryPort = Pick<CoreChatPort, 'view' | 'page'>;

interface Draft {
  id: string;
  timestamp: string;
  blocks: ChatBlock[];
  /** Расход по id сообщения модели: CLI повторяет строку расхода одного сообщения. */
  usage: Map<string, MessageUsage>;
  tools: Map<string, Extract<ChatBlock, { type: 'tool' }>>;
}

const record = (data: SessionStreamEvent['data']): Record<string, unknown> =>
  data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};

const textOf = (data: SessionStreamEvent['data']): string => {
  const t = record(data).text;
  return typeof t === 'string' ? t : '';
};

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function usageOf(draft: Draft, model: string | undefined): MessageUsage | undefined {
  if (draft.usage.size === 0) return undefined;
  const sum: MessageUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const u of draft.usage.values()) {
    sum.input += u.input;
    sum.output += u.output;
    sum.cacheRead += u.cacheRead;
    sum.cacheCreation += u.cacheCreation;
  }
  return model ? { ...sum, model } : sum;
}

/** Часы свёртки: стена последнего хода, переходит от сеанса к сеансу и от задачи к задаче. */
interface Clock {
  at: number;
}

/**
 * События одного сеанса → сообщения ленты в словаре транскрипта: ход человека — его слова без
 * служебной шапки (`humanTextOf`), ответ — куски текста склеены, размышление, вызовы инструментов
 * (ввод строкой JSON, как у транскрипта) с пометкой ошибки результата, расход сложен. Конец хода
 * закрывает ответ; повтор события (тот же ключ вида) отсеивается.
 */
export function foldSessionEvents(
  sessionId: string,
  events: readonly SessionStreamEvent[],
  model: string | undefined,
  clock: Clock = { at: 0 },
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let reply: Draft | undefined;
  const iso = (): string => new Date(clock.at).toISOString();
  const close = (): void => {
    if (reply && reply.blocks.length > 0) {
      const usage = usageOf(reply, model);
      out.push({
        id: reply.id,
        role: 'assistant',
        blocks: reply.blocks,
        timestamp: reply.timestamp,
        ...(usage ? { usage } : {}),
      });
    }
    reply = undefined;
  };
  const open = (offset: number): Draft =>
    (reply ??= {
      id: `${sessionId}:${offset}:assistant`,
      timestamp: iso(),
      blocks: [],
      usage: new Map(),
      tools: new Map(),
    });
  const append = (draft: Draft, type: 'text' | 'thinking', piece: string): void => {
    const last = draft.blocks.at(-1);
    if (last?.type === type) last.text += piece;
    else draft.blocks.push({ type, text: piece });
  };
  // Вид читается одной страницей с нуля: повтора хода человека на стыке страниц здесь нет.
  for (const event of events) {
    const data = record(event.data);
    switch (event.kind) {
      case 'user-text': {
        close();
        clock.at = sentAtOf(event) ?? clock.at;
        const said = humanTextOf(textOf(event.data));
        if (said.trim()) {
          out.push({
            id: `${sessionId}:${event.offset}:user`,
            role: 'user',
            blocks: [{ type: 'text', text: said }],
            timestamp: iso(),
          });
        }
        continue;
      }
      case 'assistant-text':
      case 'thinking': {
        const piece = textOf(event.data);
        if (piece)
          append(open(event.offset), event.kind === 'thinking' ? 'thinking' : 'text', piece);
        continue;
      }
      case 'tool-call': {
        const draft = open(event.offset);
        const block = {
          type: 'tool' as const,
          name: String(data.name ?? ''),
          input: JSON.stringify(data.input ?? {}),
        };
        draft.blocks.push(block);
        if (typeof data.toolUseId === 'string') draft.tools.set(data.toolUseId, block);
        continue;
      }
      case 'tool-result': {
        const block =
          typeof data.toolUseId === 'string' ? reply?.tools.get(data.toolUseId) : undefined;
        if (block && data.isError === true) block.isError = true;
        continue;
      }
      case 'usage': {
        const draft = open(event.offset);
        const id = typeof data.messageId === 'string' ? data.messageId : `#${event.offset}`;
        draft.usage.set(id, {
          input: count(data.input),
          output: count(data.output),
          cacheRead: count(data.cacheRead),
          // Ядро зовёт запись кэша `cacheWrite`, лента панели — `cacheCreation` (как `translate.ts`).
          cacheCreation: count(data.cacheWrite),
        });
        continue;
      }
      case 'turn-end': {
        const said = typeof data.text === 'string' ? data.text.trim() : '';
        // Ход кончился ошибкой — её слова CLI в ответе: без них ход в истории молча пустой.
        if (data.isError === true && said)
          open(event.offset).blocks.push({ type: 'text', text: said });
        close();
        continue;
      }
      default:
        continue;
    }
  }
  close();
  return out;
}

/** Свёртка одной задачи: её сообщения, конец потоков и число журнала, на котором прочитана. */
interface TaskFold {
  seq: number;
  ended: boolean;
  messages: ChatMessage[];
  /** Сумма курсоров `next` сеансов задачи — растёт с каждой строкой вывода. */
  bytes: number;
  lastAt: number;
  model?: string;
}

/** Сводка разговора: сообщения всех его задач по порядку и отпечаток для опроса. */
interface Loaded {
  messages: ChatMessage[];
  bytes: number;
  lastAt: number;
  model?: string;
}

const flat = (message: ChatMessage): string =>
  message.blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Название по первой реплике — без вводных панели и без ссылок, как у транскрипта Claude
 * (`chatTitleText`): у продолжения в чистой сессии это предложение прошлой сессии, а не одинаковая
 * у всех вводная «This is a new session…»; задание, начатое адресом трекера, зовётся ключом задачи,
 * а не адресом. Абзацы различимы только до склейки в строку — отсюда порядок.
 */
const titleOf = (message: ChatMessage): string =>
  cutTitle(
    withoutLinks(
      withoutPanelPreamble(message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')),
    ),
  );

/**
 * Лента для показа: первая реплика без инициативы панели, приписанной чужому CLI после задания
 * (`withoutInitiativeTail`). У продолжения Claude она — системная подсказка и в ленте не видна;
 * задание в журнале ядра остаётся как ушло. Кусков текста у реплики может быть несколько — всё
 * после начала инициативы снимается.
 */
function shownFeed(messages: ChatMessage[]): ChatMessage[] {
  const first = messages.findIndex((m) => m.role === 'user');
  if (first < 0) return messages;
  const message = messages[first]!;
  let cut = false;
  const blocks: ChatBlock[] = [];
  for (const block of message.blocks) {
    if (block.type !== 'text') {
      blocks.push(block);
      continue;
    }
    if (cut) continue;
    const text = withoutInitiativeTail(block.text);
    cut = text !== block.text;
    if (text) blocks.push(cut ? { ...block, text } : block);
  }
  if (!cut) return messages;
  return messages.map((m, i) => (i === first ? { ...message, blocks } : m));
}

/** Имя каталога проекта в словаре Claude Code: всё, кроме латиницы и цифр, — дефис. */
const projectNameOf = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export function summaryOf(entry: CoreChatHistoryEntry, loaded: Loaded): ChatSummary | undefined {
  const { messages } = loaded;
  if (messages.length === 0) return undefined;
  const firstUser = messages.find((m) => m.role === 'user');
  const said = firstUser ? titleOf(firstUser) : '';
  const cwd = entry.cwd ?? '';
  const project = projectNameOf(cwd);
  const preview = flat(messages.at(-1)!).slice(0, 160);
  // Разговор в git-копии числится и за основной копией — как у сводки транскрипта.
  const home = cwd ? layoutForCwd(cwd).mainDir : undefined;
  return {
    id: entry.id,
    title: said || project || entry.cli,
    ...(said ? {} : { untitled: true }),
    project,
    projectPath: cwd,
    isSandbox: Boolean(cwd) && isSandboxPath(cwd),
    ...(home ? { homeProjectPath: home } : {}),
    messageCount: messages.length,
    createdAt: messages[0]!.timestamp,
    updatedAt: new Date(loaded.lastAt).toISOString(),
    ...(preview ? { preview } : {}),
    ...(loaded.model ? { model: loaded.model } : {}),
  };
}

export interface CoreChatHistory {
  /** Сводки разговоров не-Claude CLI для `/api/chats`; ядро молчит — последняя известная. */
  summaries(): Promise<ChatSummary[]>;
  /** Лента окном, как у транскрипта; разговор не из книги (Claude, чужой id) — `undefined`. */
  messages(
    id: string,
    window: { limit: number; offset: number },
  ): Promise<ChatMessagesPage | undefined>;
  /** Отпечаток для опроса `/version`: `mtimeMs` — стена последнего хода, `size` — байты вывода. */
  version(id: string): Promise<{ mtimeMs: number; size: number } | undefined>;
}

export function createCoreChatHistory(
  port: HistoryPort,
  /** Файл книги — спросом: каталог данных панели меняется вместе с выбором папки конфигурации. */
  bookFile: () => string,
): CoreChatHistory {
  /** Свёртки задач: кончившаяся задача на том же числе журнала читается из памяти. */
  const folds = new Map<string, TaskFold>();

  async function foldTask(taskId: string, clock: Clock): Promise<TaskFold | null> {
    const kept = folds.get(taskId);
    let view;
    try {
      view = await port.view(taskId);
    } catch (error) {
      // Ядро молчит — последняя свёртка задачи, если есть: список не теряет разговор.
      if (kept) {
        clock.at = kept.lastAt;
        return kept;
      }
      throw error;
    }
    if (!view) return null;
    const ended = view.ended !== null;
    if (kept && kept.ended && ended && kept.seq === view.seq) {
      clock.at = kept.lastAt;
      return kept;
    }
    const sessions = [...view.sessions].sort((a, b) => a.startedSeq - b.startedSeq);
    const messages: ChatMessage[] = [];
    let bytes = 0;
    let model: string | undefined;
    for (const s of sessions) {
      const asked = s.modelServed ?? s.modelAsked ?? undefined;
      const page = await port.page(taskId, s.sessionId, 0);
      messages.push(...foldSessionEvents(s.sessionId, page.events, asked, clock));
      bytes += page.next;
      model = asked ?? model;
    }
    const fold: TaskFold = {
      seq: view.seq,
      ended,
      messages,
      bytes,
      lastAt: clock.at,
      ...(model ? { model } : {}),
    };
    folds.set(taskId, fold);
    return fold;
  }

  async function load(entry: CoreChatHistoryEntry): Promise<Loaded> {
    const clock: Clock = { at: 0 };
    const out: Loaded = { messages: [], bytes: 0, lastAt: 0 };
    for (const taskId of entry.tasks) {
      const fold = await foldTask(taskId, clock);
      if (!fold) continue;
      out.messages.push(...fold.messages);
      out.bytes += fold.bytes;
      if (fold.model) out.model = fold.model;
    }
    out.lastAt = clock.at;
    return out;
  }

  return {
    async summaries() {
      const out: ChatSummary[] = [];
      for (const entry of coreChatHistoryEntries(bookFile())) {
        try {
          const one = summaryOf(entry, await load(entry));
          if (one) out.push(one);
        } catch {
          // Ядро недоступно и свёртки нет — разговора в списке нет до ответа ядра, список жив.
        }
      }
      return out;
    },
    async messages(id, window) {
      const entry = coreChatHistoryEntry(bookFile(), id);
      if (!entry) return undefined;
      const messages = shownFeed((await load(entry)).messages);
      const total = messages.length;
      // Окно то же, что у транскрипта: `offset` отступает от конца, `limit` — назад от него.
      const endExcl = Math.max(0, total - window.offset);
      const start = Math.max(0, endExcl - window.limit);
      return { messages: messages.slice(start, endExcl), total, hasMore: start > 0 };
    },
    async version(id) {
      const entry = coreChatHistoryEntry(bookFile(), id);
      if (!entry) return undefined;
      const loaded = await load(entry);
      return { mtimeMs: loaded.lastAt, size: loaded.bytes };
    },
  };
}
