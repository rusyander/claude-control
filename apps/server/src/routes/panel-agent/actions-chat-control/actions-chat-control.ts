import { z } from 'zod';
import type { ChatSummary } from '@agentdeck/contracts';
import { encode, readRoute } from '../action-kit/action-kit.ts';
import {
  assertClaudeChat,
  chatField,
  chatEdits,
  chatSendPlan,
  continueBody,
  findChat,
  maskedTitle,
  planFields,
  readTree,
  runningOf,
  sendOutcome,
  sendRefusal,
  stateField,
  type ActiveRun,
} from '../actions-chat-kit.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import { dataField, summaryText, textField } from '../texts/texts.ts';

/**
 * Правки агента в чатах (U1): написать в чат, стоп, пауза и продолжение дерева.
 * Каждая — тем же маршрутом, что кнопка окна чата, и только по карточке человека.
 *
 * Чего здесь нет намеренно (решает человек): решения по правам и воротам ветки,
 * автоподтверждение и `force` сверх потолка очереди.
 */

/** Чат вызова — между шагами одного вызова (`route` → `shape` → `page`). */
const chatOf = new WeakMap<object, ChatSummary>();

const chatRef = z
  .string()
  .min(1)
  .describe('Chat id (from list_chats / search_chats / read_chat) or its exact title');

const chatPage = (input: object) => {
  const chat = chatOf.get(input);
  return chat ? { route: '/chat', focus: chat.id } : { route: '/chat' };
};

// ── send_chat_message ─────────────────────────────────────────────────────

const sendInput = z.object({
  chat: chatRef,
  message: z.string().trim().min(1).max(20_000).describe('The message, as the human would type it'),
});

const sendChatMessage = definePanelAction({
  name: 'send_chat_message',
  section: 'chat',
  risk: 'danger',
  title: 'journal-send-chat-message',
  description:
    'Write a message into an EXISTING chat as the human would from its composer: continues the ' +
    'same session, with the model and effort that chat runs on. A busy chat queues it until its ' +
    'turn ends. Answer a chat agent’s question only with the human’s own choice. Needs the ' +
    'human’s confirmation; returns at once — the chat works on its own, read_chat later.',
  input: sendInput,
  route: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    await assertClaudeChat(inject, 'send_chat_message');
    chatOf.set(input, chat);
    const plan = await chatSendPlan(inject, chat);
    return {
      method: 'POST',
      url: '/api/chat/send',
      stream: true,
      body: continueBody(chat, input.message, plan, await chatEdits(inject, chat)),
    };
  },
  // Занят ли чат — не часть отпечатка: ход кончился между показом и кликом —
  // сообщение просто уйдёт сразу, а не после хода.
  fingerprint: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    return fingerprintOf({
      chat: chat.id,
      project: chat.projectPath,
      plan: await chatSendPlan(inject, chat),
      message: input.message,
      allowEdits: await chatEdits(inject, chat),
    });
  },
  preview: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    await assertClaudeChat(inject, 'send_chat_message');
    const plan = await chatSendPlan(inject, chat);
    const busy = Boolean(await runningOf(inject, chat.id));
    return {
      ...summaryText('summary-send-chat-message', { chat: maskedTitle(chat) }),
      fields: [
        chatField(chat),
        ...planFields(plan),
        textField(
          'label-file-edits',
          (await chatEdits(inject, chat)) ? 'value-edits-allowed' : 'value-edits-denied',
        ),
        stateField(busy),
        // Текст целиком: обрезанный хвост ушёл бы агенту непрочитанным.
        dataField('label-message', input.message),
      ],
    };
  },
  refusal: sendRefusal,
  shape: (input, body) => {
    const chat = chatOf.get(input);
    if (!chat) return { sent: true };
    return sendOutcome(chat, body);
  },
  page: (input) => chatPage(input),
});

// ── stop_chat_run ─────────────────────────────────────────────────────────

interface StopTarget {
  run: ActiveRun;
  title: string;
  chat?: ChatSummary;
}

/**
 * Идущий прогон по чату: ключ реестра или имя сессии (новый чат без
 * транскрипта есть только в прогонах), иначе чат списка по названию.
 */
async function stopTarget(inject: InjectRoute, ref: string): Promise<StopTarget> {
  const direct = await runningOf(inject, ref.trim());
  const chats = await readRoute<ChatSummary[]>(inject, '/api/chats');
  if (direct) {
    const chat = chats.find((item) => item.id === direct.sessionId || item.id === direct.chatId);
    return { run: direct, title: chat ? maskedTitle(chat) : ref, ...(chat ? { chat } : {}) };
  }
  const chat = await findChat(inject, ref);
  const run = await runningOf(inject, chat.id);
  if (!run) {
    throw new Error(`The agent in chat «${maskedTitle(chat)}» is not running — nothing to stop.`);
  }
  return { run, title: maskedTitle(chat), chat };
}

const stopChatRun = definePanelAction({
  name: 'stop_chat_run',
  section: 'chat',
  risk: 'change',
  title: 'journal-stop-chat-run',
  description:
    'Stop the running agent of a chat, like its Stop button: the turn is cut short. Needs the ' +
    'human’s confirmation.',
  input: z.object({
    chat: z.string().min(1).describe('Chat id, title, or run key from list_active_runs'),
  }),
  route: async (input, inject) => {
    const target = await stopTarget(inject, input.chat);
    return { method: 'POST', url: `/api/chat/${encode(target.run.chatId)}/stop`, body: {} };
  },
  fingerprint: async (input, inject) => {
    const target = await stopTarget(inject, input.chat);
    return fingerprintOf({ key: target.run.chatId, startedAt: target.run.startedAt });
  },
  preview: async (input, inject) => {
    const target = await stopTarget(inject, input.chat);
    return {
      ...summaryText('summary-stop-chat-run', { chat: target.title }),
      fields: [
        target.chat ? chatField(target.chat) : dataField('label-chat', target.title),
        textField('label-what-happens', 'value-stop-run'),
      ],
    };
  },
  refusal: (body) =>
    (body as { ok?: boolean } | undefined)?.ok === false
      ? 'The run had already ended by the time of the click.'
      : undefined,
  shape: () => ({ stopped: true }),
});

// ── split_control ─────────────────────────────────────────────────────────

/**
 * Пауза и продолжение всего дерева чата — кнопки дерева окна. Групп разделения
 * больше нет (задачи ведёт ядро), и режимы одной группы ушли вместе с ними;
 * имя действия осталось — им пауза дерева называлась и в журналах.
 */
const TREE_MODES = ['pause_all', 'resume_all'] as const;
type TreeMode = (typeof TREE_MODES)[number];

const MODE_ROUTE: Record<TreeMode, string> = { pause_all: 'pause', resume_all: 'resume' };
const MODE_SUMMARY = {
  pause_all: 'summary-tree-pause',
  resume_all: 'summary-tree-resume',
} as const;
const MODE_EFFECT = {
  pause_all: 'value-tree-pause-effect',
  resume_all: 'value-tree-resume-effect',
} as const;

/**
 * «Продолжить» сдавшуюся группу (решение 25.10: агент окна жмёт его сам) — у задачи ядра это
 * ответ «continue» на вопрос потолка кругов (источник `round-cap`, пункт 6). Ответ `answer` у
 * ядра — класс `human-strict` (06 §Authority): его доказывает только число страницы браузера при
 * чистом пире или подпись устройства, а шаг окна агента не несёт ни того, ни другого — ядро
 * отвечает `signature-required` (живой прогон `check-core-permit-auto.mjs`, 02.11). Поэтому
 * режим остался названным отказом до карточки, а не тихо пропал из списка.
 */
export const CONTINUE_GROUP_REFUSAL =
  'core-continue-human-only: a task that stopped at its round cap goes on only by the human’s ' +
  'answer «continue» on the task’s question in the panel — the task core accepts an answer only ' +
  'with the browser page’s proof or a paired device’s signature, and a step of this window ' +
  'carries neither. Nothing was executed; tell the human which task stopped and ask them to ' +
  'press «Continue» on its question.';

const treeControlInput = z.object({
  chat: chatRef.describe('Any chat of the tree'),
  mode: z
    .enum([...TREE_MODES, 'continue_group'])
    .describe(
      'pause_all / resume_all — every run of the whole tree; continue_group — refused: a task ' +
        'that gave up continues only by the human’s answer',
    ),
});

async function treeTarget(
  input: z.infer<typeof treeControlInput>,
  inject: InjectRoute,
): Promise<{ chat: Awaited<ReturnType<typeof findChat>>; paused: boolean; mode: TreeMode }> {
  const { mode } = input;
  if (mode === 'continue_group') throw new Error(CONTINUE_GROUP_REFUSAL);
  const chat = await findChat(inject, input.chat);
  const paused = Boolean((await readTree(inject, chat.id)).paused);
  if (mode === 'pause_all' && paused) {
    throw new Error('Nothing would change: this tree is already paused.');
  }
  if (mode === 'resume_all' && !paused) {
    throw new Error('Nothing would change: this tree is not paused.');
  }
  return { chat, paused, mode };
}

const splitControl = definePanelAction({
  name: 'split_control',
  section: 'chat',
  risk: 'change',
  title: 'journal-split-control',
  description:
    'Pause or resume every run of a chat’s tree (the chat and its child chats), as the tree’s ' +
    'buttons do. Needs the human’s confirmation.',
  input: treeControlInput,
  route: async (input, inject) => {
    const target = await treeTarget(input, inject);
    chatOf.set(input, target.chat);
    return {
      method: 'POST',
      url: `/api/chat/${encode(target.chat.id)}/tree/${MODE_ROUTE[target.mode]}`,
      body: {},
    };
  },
  fingerprint: async (input, inject) => {
    const target = await treeTarget(input, inject);
    return fingerprintOf({ chat: target.chat.id, mode: target.mode, paused: target.paused });
  },
  preview: async (input, inject) => {
    const target = await treeTarget(input, inject);
    return {
      ...summaryText(MODE_SUMMARY[target.mode], { chat: maskedTitle(target.chat) }),
      fields: [chatField(target.chat), textField('label-what-happens', MODE_EFFECT[target.mode])],
    };
  },
  page: (input) => chatPage(input),
});

/** Правки раздела «Чат» (U1) в порядке показа. */
export const CHAT_CONTROL_ACTIONS: readonly AnyPanelAction[] = [
  sendChatMessage,
  stopChatRun,
  splitControl,
];
