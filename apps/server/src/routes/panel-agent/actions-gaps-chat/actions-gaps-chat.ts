import { z } from 'zod';
import type { ChatAutoModeView, ChatSummary } from '@agentdeck/contracts';
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';
import { encode, readRoute } from '../action-kit/action-kit.ts';
import {
  assertClaudeChat,
  chatEdits,
  chatField,
  chatSendPlan,
  continueBody,
  findChat,
  maskedTitle,
  planFields,
  runningOf,
  sendOutcome,
  sendRefusal,
  stateField,
} from '../actions-chat-kit.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import { maskResult } from '../result-net/result-net.ts';
import { summaryText, textField } from '../texts/texts.ts';

/**
 * Чат, которого агенту не хватало (дорожка A, 28.09): режимы и расход чата,
 * «Закрыть этап», понижённые прогоны. Каждое — тем же
 * маршрутом, что кнопка окна чата; правки — по карточке. Человеку остаются
 * решения по правам и ревью.
 */

const chatRef = z
  .string()
  .min(1)
  .describe('Chat id (from list_chats / search_chats / read_chat) or its exact title');

/** Чат вызова — между шагами одного вызова (`route` → `shape` → `page`). */
const chatOf = new WeakMap<object, ChatSummary>();

const chatPage = (input: object) => {
  const chat = chatOf.get(input);
  return chat ? { route: '/chat', focus: chat.id } : { route: '/chat' };
};

// ── read_chat_modes ───────────────────────────────────────────────────────

interface HandoffState {
  auto: boolean;
  depth: number;
  maxChain: number;
}

const handoffOf = new WeakMap<object, HandoffState>();

const readChatModes = definePanelAction({
  name: 'read_chat_modes',
  section: 'chat',
  risk: 'read',
  description:
    'The modes of one chat as its menu shows them: auto mode of permissions (on/off, chosen in ' +
    'this chat or inherited from the global setting), whether its last run could edit files, and ' +
    'the stage chain (auto-continue in a new session, current depth and its ceiling).',
  input: z.object({ chat: chatRef }),
  route: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    chatOf.set(input, chat);
    handoffOf.set(
      input,
      await readRoute<HandoffState>(
        inject,
        `/api/chat/handoff/state?chatId=${encode(chat.id)}&sessionId=${encode(chat.id)}`,
      ),
    );
    return {
      method: 'GET',
      url: `/api/chat/${encode(chat.id)}/auto-mode?sessionId=${encode(chat.id)}`,
    };
  },
  shape: (input, body) => {
    const view = body as ChatAutoModeView;
    const chat = chatOf.get(input);
    const handoff = handoffOf.get(input);
    return {
      ...(chat ? { chat: chat.id, title: maskedTitle(chat) } : {}),
      autoMode: {
        enabled: view.enabled,
        chosenInThisChat: view.override !== undefined,
        global: view.global,
      },
      edits: view.allowEdits ?? null,
      ...(handoff
        ? {
            stageChain: {
              autoContinue: handoff.auto,
              depth: handoff.depth,
              maxDepth: handoff.maxChain,
            },
          }
        : {}),
    };
  },
  summary: 'journal-read-chat-modes',
});

// ── read_chat_spend ───────────────────────────────────────────────────────

const readChatSpend = definePanelAction({
  name: 'read_chat_spend',
  section: 'chat',
  risk: 'read',
  description:
    'Tokens spent by all chat runs since the panel server started (the counter of the agents ' +
    'console) and the notional API-price estimate of them. The subscription is not billed per ' +
    'token: costUsd is an estimate, never a bill. For history by day use analytics_summary.',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/chat/spend' }),
  shape: (_input, body) => {
    const spend = body as { costUsd: number; tokens: number };
    return {
      tokens: spend.tokens,
      estimatedCostUsd: spend.costUsd,
      note: 'Since the panel server started; a notional API price, not what the subscription bills.',
    };
  },
  summary: 'journal-read-chat-spend',
});

// ── request_chat_handoff ──────────────────────────────────────────────────

/** Просьба «Закрыть этап» — текст сервера, тот же, что у кнопки чата. */
async function handoffPrompt(inject: InjectRoute): Promise<string> {
  const answer = await readRoute<{ prompt: string }>(inject, '/api/chat/handoff/request');
  return answer.prompt;
}

/** Продолжение в новой сессии заводится в каталоге проекта — у чата панели его нет. */
function assertProjectChat(chat: ChatSummary): void {
  if (chat.isSandbox || !chat.projectPath) {
    throw new Error(
      `Chat «${maskedTitle(chat)}» lives in the panel itself, without a project: closing a stage ` +
        'prepares a continuation in a new session of a project chat, so it is not offered here.',
    );
  }
}

const requestChatHandoff = definePanelAction({
  name: 'request_chat_handoff',
  section: 'chat',
  risk: 'danger',
  title: 'journal-request-chat-handoff',
  description:
    'Ask the agent of a project chat to close the current stage and prepare its continuation in ' +
    'a new session — the same request as the chat’s «Закрыть этап» button. The chat agent ' +
    'answers with a continuation block; moving to the new session is a separate step ' +
    '(restart_chat_session when the human asks). Spends a turn of the subscription. Needs the ' +
    'human’s confirmation.',
  input: z.object({ chat: chatRef }),
  route: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    assertProjectChat(chat);
    await assertClaudeChat(inject, 'request_chat_handoff');
    chatOf.set(input, chat);
    const plan = await chatSendPlan(inject, chat);
    return {
      method: 'POST',
      url: '/api/chat/send',
      stream: true,
      body: continueBody(chat, await handoffPrompt(inject), plan, await chatEdits(inject, chat)),
    };
  },
  fingerprint: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    return fingerprintOf({
      chat: chat.id,
      project: chat.projectPath,
      plan: await chatSendPlan(inject, chat),
      edits: await chatEdits(inject, chat),
      prompt: await handoffPrompt(inject),
    });
  },
  // Карточка называет просьбу, а не её текст: он служебный (формат ответа).
  preview: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    assertProjectChat(chat);
    await assertClaudeChat(inject, 'request_chat_handoff');
    const plan = await chatSendPlan(inject, chat);
    const busy = Boolean(await runningOf(inject, chat.id));
    return {
      ...summaryText('summary-request-chat-handoff', { chat: maskedTitle(chat) }),
      fields: [
        chatField(chat),
        ...planFields(plan),
        stateField(busy),
        textField('label-message', 'value-handoff-request-standard'),
        textField('label-what-happens', 'value-handoff-request-next'),
      ],
    };
  },
  refusal: sendRefusal,
  shape: (input, body) => {
    const chat = chatOf.get(input);
    return {
      ...(chat ? sendOutcome(chat, body) : { sent: true }),
      next:
        'The chat agent answers with a continuation block in that chat. The new session starts ' +
        'only when the human (or you, on their request, with restart_chat_session) asks.',
    };
  },
  page: (input) => chatPage(input),
});

// ── list_lowered_runs ─────────────────────────────────────────────────────

const listLoweredRuns = definePanelAction({
  name: 'list_lowered_runs',
  section: 'chat',
  risk: 'read',
  description:
    'Journal of runs the model picker sent to a cheaper step: a summary (how many, how many ran ' +
    'checks, how many failed, tokens, per kind of work) and the latest runs, newest first.',
  input: z.object({
    limit: z.number().int().min(1).max(50).default(10).describe('How many latest runs to list'),
  }),
  route: () => ({ method: 'GET', url: '/api/chat/lowered-runs' }),
  shape: (input, body) => {
    const answer = body as { runs: LoweredRunRecord[]; summary: unknown };
    return maskResult({
      summary: answer.summary,
      total: answer.runs.length,
      runs: answer.runs.slice(0, input.limit).map((run) => ({
        chatId: run.chatId,
        ...(run.projectPath ? { projectPath: run.projectPath } : {}),
        model: run.model,
        effort: run.effort,
        ...(run.kind ? { kind: run.kind } : {}),
        ok: run.ok,
        startedAt: new Date(run.startedAt).toISOString(),
        durationSec: Math.round((run.finishedAt - run.startedAt) / 1000),
        checks: run.checks.slice(0, 5),
        ...(run.tokens !== undefined ? { tokens: run.tokens } : {}),
      })),
    });
  },
  summary: 'journal-list-lowered-runs',
});

/** Действия чата дорожки A в порядке показа. */
export const GAPS_CHAT_ACTIONS: readonly AnyPanelAction[] = [
  readChatModes,
  readChatSpend,
  requestChatHandoff,
  listLoweredRuns,
];
