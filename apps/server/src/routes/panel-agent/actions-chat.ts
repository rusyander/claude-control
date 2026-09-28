import { z } from 'zod';
import type { ChatMessagesPage, ChatProgress, ChatSummary } from '@agentdeck/contracts';
import type { ChatInbox } from '@agentdeck/contracts/chat-inbox';
import type { ChatAwaitingView } from '@agentdeck/contracts/chat-handoff';
import type { ChatEscalationsView } from '@agentdeck/contracts/chat-group-settings';
import { scanSplitBlocks, type TaskSplitProposal } from '@agentdeck/contracts/task-split';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import type { ProjectInfo } from '../../domains/chat/ChatProjects.ts';
import { encode, readRoute } from './action-kit.ts';
import { findChat, readTree, runningOf } from './actions-chat-kit.ts';
import { CHAT_CONTROL_ACTIONS } from './actions-chat-control.ts';
import { definePanelAction, type AnyPanelAction, type InjectRoute } from './registry.ts';

/**
 * Чтения агента по чатам (U1): лента разговора, поиск по переписке и что в
 * чатах ждёт человека. Всё — маршрутами окна чата; тексты переписки идут модели
 * через маску секретов (в первом сообщении люди вставляют ключи).
 */

/** Сколько символов текста одного сообщения видит модель. */
const MESSAGE_CHARS = 1500;
/** Предел ответа чтения: переходник режет на 20 000, запас — на обёртку. */
const READ_BUDGET = 15_000;

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** Чат, найденный маршрутом чтения, — второму шагу того же вызова. */
const resolvedChats = new WeakMap<object, ChatSummary>();

interface AskQuestion {
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  options?: Array<{ label?: unknown }>;
}

/** Вопрос `AskUserQuestion` из блока инструмента: вход лежит строкой JSON. */
function askOf(input: string): { questions: Array<Record<string, unknown>> } | undefined {
  try {
    const parsed = JSON.parse(input) as { questions?: AskQuestion[] };
    if (!Array.isArray(parsed.questions)) return undefined;
    return {
      questions: parsed.questions.map((item) => ({
        question: maskSecretsInText(String(item.question ?? '')),
        ...(typeof item.header === 'string' ? { header: item.header } : {}),
        ...(item.multiSelect === true ? { multiSelect: true } : {}),
        options: (item.options ?? []).map((option) =>
          maskSecretsInText(String(option.label ?? '')),
        ),
      })),
    };
  } catch {
    return undefined;
  }
}

const proposalView = (proposal: TaskSplitProposal) => ({
  groups: proposal.groups.map((group) => ({
    title: maskSecretsInText(group.title),
    tasks: group.tasks.map((task) => clip(maskSecretsInText(task), 200)),
  })),
});

type MessageView = {
  role: string;
  at: string;
  text: string;
  tools?: string[];
  split?: ReturnType<typeof proposalView>;
};

/** Сообщение ленты глазами модели: текст без блоков предложения, имена инструментов. */
function messageView(message: ChatMessagesPage['messages'][number]): {
  view: MessageView;
  proposals: TaskSplitProposal[];
  ask?: ReturnType<typeof askOf>;
} {
  const texts: string[] = [];
  const tools: string[] = [];
  let ask: ReturnType<typeof askOf>;
  for (const block of message.blocks) {
    if (block.type === 'text') texts.push(block.text);
    else if (block.type === 'tool') {
      tools.push(block.name);
      if (block.name === 'AskUserQuestion') ask = askOf(block.input) ?? ask;
    }
  }
  const scan = scanSplitBlocks(texts.join('\n\n'));
  const proposal = scan.proposals.at(-1);
  return {
    view: {
      role: message.role,
      at: message.timestamp,
      text: clip(maskSecretsInText(scan.text), MESSAGE_CHARS),
      ...(tools.length > 0 ? { tools } : {}),
      ...(proposal ? { split: proposalView(proposal) } : {}),
    },
    proposals: scan.proposals,
    ...(ask ? { ask } : {}),
  };
}

/** План разделения дерева чата — только то, чем агент управляет `split_control`. */
async function splitOf(inject: InjectRoute, chatId: string) {
  try {
    const tree = await readTree(inject, chatId);
    return {
      ...(tree.paused ? { treePaused: { since: tree.paused.at, chats: tree.paused.chats } } : {}),
      ...(tree.split
        ? {
            split: {
              parentChatId: tree.split.parentChatId,
              ...(tree.split.cancelledAt ? { cancelledAt: tree.split.cancelledAt } : {}),
              groups: tree.split.groups.map((group) => ({
                index: group.index,
                title: maskSecretsInText(group.title),
                status: group.status,
                ...(group.waitingFor ? { waitingFor: group.waitingFor } : {}),
                ...(group.hold && !group.holdAnswer
                  ? { question: maskSecretsInText(group.hold) }
                  : {}),
                ...(group.after.length > 0 ? { after: group.after } : {}),
                ...(group.chatId ? { chatId: group.chatId } : {}),
                ...(group.mr ? { mr: group.mr } : {}),
              })),
            },
          }
        : {}),
    };
  } catch {
    // Дерево — довесок к ленте: без него лента всё равно ответ.
    return {};
  }
}

/** План агента чата (его чекпоинты), живой инструмент и фон — как полоса прогресса чата. */
async function progressOf(inject: InjectRoute, chatId: string) {
  try {
    const progress = await readRoute<ChatProgress>(inject, `/api/chat/${encode(chatId)}/progress`);
    const shells = (progress.shells ?? []).filter((shell) => shell.status === 'running');
    const agents = progress.agents.filter((agent) => agent.status === 'running');
    if (
      progress.tasks.length === 0 &&
      shells.length === 0 &&
      agents.length === 0 &&
      !progress.activeTool
    ) {
      return {};
    }
    return {
      progress: {
        ...(progress.tasks.length > 0
          ? {
              plan: progress.tasks.slice(0, 30).map((task) => ({
                text: clip(maskSecretsInText(task.text), 200),
                status: task.status,
              })),
            }
          : {}),
        ...(progress.activeTool
          ? {
              nowRunning: `${progress.activeTool.name}: ${clip(maskSecretsInText(progress.activeTool.summary), 200)}`,
            }
          : {}),
        ...(agents.length > 0 ? { subagentsRunning: agents.length } : {}),
        ...(shells.length > 0 ? { backgroundCommands: shells.length } : {}),
      },
    };
  } catch {
    return {};
  }
}

const readChatInput = z.object({
  chat: z.string().min(1).describe('Chat id (from list_chats / search_chats) or its exact title'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('How many messages from the end (default 20)'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Skip this many newest messages — pass nextOffset to page back'),
});

const readChat = definePanelAction({
  name: 'read_chat',
  section: 'chat',
  risk: 'read',
  summary: 'journal-read-chat',
  description:
    'Read a chat: its latest messages (newest last, text clipped, secrets masked), whether the ' +
    'chat agent is running now, an open question of the chat agent (answer it with ' +
    'send_chat_message only with the human’s choice), a split proposal (the human applies it ' +
    'with the «Разделить на N чата» button — you never can) and the split plan of its tree ' +
    '(groups with index and status, for split_control).',
  input: readChatInput,
  route: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    resolvedChats.set(input, chat);
    const limit = input.limit ?? 20;
    return {
      method: 'GET',
      url: `/api/chats/${encode(chat.id)}/messages?limit=${limit}&offset=${input.offset ?? 0}`,
    };
  },
  afterRoute: async (input, body, inject) => {
    const chat = resolvedChats.get(input);
    if (!chat) throw new Error('The chat was not resolved; call read_chat again.');
    const page = body as ChatMessagesPage;
    const run = await runningOf(inject, chat.id);
    const views = page.messages.map(messageView);
    // Последнее предложение ленты и открытый вопрос — отдельно: ради них и читают.
    const lastProposal = views.flatMap((item) => item.proposals).at(-1);
    const lastAsk = chat.awaitingReply ? views.findLast((item) => item.ask)?.ask : undefined;
    let messages = views.map((item) => item.view);
    const head = {
      chat: {
        id: chat.id,
        title: maskSecretsInText(chat.title),
        ...(chat.isSandbox ? { inPanel: true } : { projectPath: chat.projectPath }),
        running: Boolean(run),
        ...(chat.awaitingReply ? { awaitingReply: true } : {}),
        ...(chat.paused ? { paused: true } : {}),
      },
      total: page.total,
      ...(page.hasMore ? { nextOffset: (input.offset ?? 0) + page.messages.length } : {}),
      ...(lastProposal
        ? {
            splitProposal: {
              ...proposalView(lastProposal),
              note:
                `The human applies it with the «Разделить на ${lastProposal.groups.length} чата» ` +
                'button under that message in the chat. You cannot press it: offer to open the ' +
                'chat (open_page /chat with focus = chat id).',
            },
          }
        : {}),
      ...(lastAsk ? { question: lastAsk } : {}),
      ...(await progressOf(inject, chat.id)),
      ...(await splitOf(inject, chat.id)),
    };
    // Сначала уходят старые сообщения: модели нужнее конец разговора.
    let dropped = 0;
    while (messages.length > 1 && JSON.stringify({ ...head, messages }).length > READ_BUDGET) {
      messages = messages.slice(1);
      dropped += 1;
    }
    return {
      ...head,
      messages,
      ...(dropped > 0 ? { clippedOlder: dropped } : {}),
    };
  },
});

const searchChats = definePanelAction({
  name: 'search_chats',
  section: 'chat',
  risk: 'read',
  summary: 'journal-search-chats',
  description:
    'Full-text search through the messages of all CLI chats (not just titles). Returns chat ids ' +
    'with a snippet around the first match and the match count; read one with read_chat.',
  input: z.object({
    query: z.string().trim().min(2).max(200).describe('Words to find, at least 2 characters'),
    limit: z.number().int().min(1).max(50).optional().describe('Max hits (default 20)'),
  }),
  route: (input) => ({ method: 'GET', url: `/api/chat/search?q=${encode(input.query)}` }),
  shape: (input, body) => {
    const hits = (body as { hits?: Array<Record<string, unknown>> }).hits ?? [];
    const limit = input.limit ?? 20;
    return {
      total: hits.length,
      hits: hits.slice(0, limit).map((hit) => ({
        id: hit.sessionId,
        title: maskSecretsInText(String(hit.title ?? '')),
        projectPath: hit.projectPath,
        snippet: maskSecretsInText(String(hit.snippet ?? '')),
        matches: hit.matchCount,
        updatedAt: hit.updatedAt,
      })),
    };
  },
});

/** Ожидание человека глазами модели: вопрос — да, права и ворота ветки — только человеку. */
function askView(ask: ChatInbox['chats'][number]['asks'][number]) {
  if (ask.kind === 'question') {
    return {
      kind: 'question',
      question: maskSecretsInText(ask.question.question),
      options: ask.question.options.map((option) => maskSecretsInText(option.label)),
    };
  }
  return {
    kind: ask.kind,
    tool: ask.toolName,
    humanOnly: true,
  };
}

const WAITING_LIMIT = 30;

const listWaiting = definePanelAction({
  name: 'list_waiting',
  section: 'chat',
  risk: 'read',
  summary: 'journal-list-waiting',
  description:
    'What in the chats waits for the human or runs now: chat agents asking a question, ' +
    'permission requests and first-edit branch gates (humanOnly — the human decides those in ' +
    'the chat, never you), running chats, unread critical notes from split groups and split ' +
    'trees standing on the human.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/chat/inbox' }),
  afterRoute: async (_input, body, inject) => {
    const inbox = body as ChatInbox;
    const [escalations, awaiting] = await Promise.all([
      readRoute<ChatEscalationsView>(inject, '/api/chat/escalations').catch(() => undefined),
      readRoute<ChatAwaitingView>(inject, '/api/chat/awaiting').catch(() => undefined),
    ]);
    const busy = inbox.chats.filter((chat) => chat.status !== 'idle' || chat.asks.length > 0);
    const notes = Object.entries(escalations?.chats ?? {}).flatMap(([chatId, entries]) =>
      entries
        .filter((entry) => !entry.read)
        .map((entry) => ({
          chat: chatId,
          from: entry.childChatId,
          fromTitle: maskSecretsInText(entry.childTitle),
          text: clip(maskSecretsInText(entry.text), 400),
          at: entry.at,
        })),
    );
    return {
      total: busy.length,
      chats: busy.slice(0, WAITING_LIMIT).map((chat) => ({
        id: chat.id,
        ...(chat.runKey && chat.runKey !== chat.id ? { runKey: chat.runKey } : {}),
        title: maskSecretsInText(chat.title),
        ...(chat.isSandbox ? { inPanel: true } : { projectPath: chat.projectPath }),
        status: chat.status,
        running: chat.running,
        updatedAt: chat.updatedAt,
        ...(chat.asks.length > 0 ? { asks: chat.asks.map(askView) } : {}),
      })),
      ...(notes.length > 0 ? { criticalNotes: notes } : {}),
      ...(awaiting && awaiting.chats.length > 0 ? { treesWaiting: awaiting.chats } : {}),
    };
  },
});

// ── list_chat_projects ────────────────────────────────────────────────────

const CHAT_PROJECTS_LIMIT = 30;

/**
 * Папки, в которых велись чаты CLI, — вкладка «Проекты» чата. Не реестр
 * проектов панели (`list_projects`): сюда попадает любая папка из транскриптов,
 * в том числе незаведённая и удалённая с диска. Самих чатов — только счётчик и
 * последний: список целиком отдаёт `list_chats` с `projectPath`.
 */
const listChatProjects = definePanelAction({
  name: 'list_chat_projects',
  section: 'chat',
  risk: 'read',
  summary: 'journal-list-chat-projects',
  description:
    'Folders where CLI chats were held (the Chat page «Проекты» tab), latest activity first: ' +
    'path, whether the folder still exists, chat count and the latest chat. Not the panel ' +
    'project registry (list_projects). For the chats of one folder call list_chats with ' +
    'projectPath. Default limit 30.',
  input: z.object({
    limit: z.number().int().min(1).max(200).optional().describe('Max folders (default 30)'),
  }),
  route: () => ({ method: 'GET', url: '/api/chats/projects' }),
  shape: (input, body) => {
    const projects = (Array.isArray(body) ? (body as ProjectInfo[]) : [])
      .slice()
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return {
      total: projects.length,
      projects: projects.slice(0, input.limit ?? CHAT_PROJECTS_LIMIT).map((project) => {
        const latest = project.chats
          .slice()
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        return {
          path: project.path,
          name: project.name,
          ...(project.exists ? {} : { missing: true }),
          lastActivity: project.lastActivity,
          chats: project.chats.length,
          ...(latest
            ? { latestChat: { id: latest.id, title: maskSecretsInText(latest.title) } }
            : {}),
        };
      }),
    };
  },
});

/** Действия раздела «Чат» (U1) в порядке показа. */
export const CHAT_ACTIONS: readonly AnyPanelAction[] = [
  readChat,
  searchChats,
  listWaiting,
  listChatProjects,
  ...CHAT_CONTROL_ACTIONS,
];
