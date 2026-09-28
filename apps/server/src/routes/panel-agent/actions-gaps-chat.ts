import { z } from 'zod';
import type { ChatAutoModeView, ChatSummary } from '@agentdeck/contracts';
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';
import type { SplitOverlapView, SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { encode, readRoute } from './action-kit.ts';
import {
  assertClaudeChat,
  chatEdits,
  chatField,
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
} from './actions-chat-kit.ts';
import { resolveTarget, copyRef, projectRef, targetLabel, pageFor } from './project-target.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { maskResult } from './result-net.ts';
import { dataField, summaryText, textField } from './texts.ts';

/**
 * Чат, которого агенту не хватало (дорожка A, 28.09): режимы и расход чата,
 * «Закрыть этап», подбор модели под задачу, понижённые прогоны, пересечения
 * веток разделения, приёмка доставленной группы и «Продолжить» оборванных.
 * Каждое — тем же маршрутом, что кнопка окна чата; правки — по карточке.
 *
 * Человеку остаются: «Начать сейчас» и «Перезапустить» разделения (применение
 * плана, `human:split-apply`), решения по правам и ревью.
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

// ── read_model_cascade / set_model_cascade ────────────────────────────────

const cascadeInput = { project: projectRef, copy: copyRef };

interface CascadeView {
  enabled: boolean;
  project: string;
}

const readModelCascade = definePanelAction({
  name: 'read_model_cascade',
  section: 'chat',
  risk: 'read',
  description:
    'Whether «Подбирать модель под задачу» is on for a project: its chats (and chats in its ' +
    'working copies) pick the model per kind of work instead of the chosen one. The switch is ' +
    'remembered per project.',
  input: z.object(cascadeInput),
  route: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    return { method: 'GET', url: `/api/chat/cascade?path=${encode(target.dir)}` };
  },
  shape: (_input, body) => {
    const view = body as CascadeView;
    return { enabled: view.enabled, project: view.project };
  },
  summary: 'journal-read-model-cascade',
});

const cascadeOf = async (inject: InjectRoute, dir: string): Promise<CascadeView> =>
  readRoute<CascadeView>(inject, `/api/chat/cascade?path=${encode(dir)}`);

const setModelCascade = definePanelAction({
  name: 'set_model_cascade',
  section: 'chat',
  risk: 'change',
  title: 'journal-set-model-cascade',
  description:
    'Turn «Подбирать модель под задачу» on or off for a project — the switch in the chat menu. ' +
    'Applies to the next runs of the project’s chats and of its working copies. Needs the ' +
    'human’s confirmation.',
  input: z.object({ ...cascadeInput, enabled: z.boolean().describe('true = on, false = off') }),
  route: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    return {
      method: 'PUT',
      url: '/api/chat/cascade',
      body: { path: target.dir, enabled: input.enabled },
    };
  },
  fingerprint: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    return fingerprintOf(await cascadeOf(inject, target.dir));
  },
  preview: async (input, inject) => {
    const target = await resolveTarget(inject, input);
    const current = await cascadeOf(inject, target.dir);
    if (current.enabled === input.enabled) {
      throw new Error(
        `Nothing would change: the switch is already ${input.enabled ? 'on' : 'off'} for this project.`,
      );
    }
    return {
      ...summaryText(
        input.enabled ? 'summary-set-model-cascade-on' : 'summary-set-model-cascade-off',
        { name: target.project.name },
      ),
      fields: [
        dataField('label-project', targetLabel(target)),
        textField(
          'label-what-happens',
          input.enabled ? 'value-model-cascade-on' : 'value-model-cascade-off',
        ),
      ],
    };
  },
  shape: (_input, body) => {
    const view = body as CascadeView;
    return { enabled: view.enabled, project: view.project };
  },
  page: (input) => pageFor(input),
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

// ── разделение: пересечения, приёмка, «Продолжить» ───────────────────────

type PlanGroup = SplitPlanView['groups'][number];

/** План разделения дерева чата или отказ словами для модели. */
async function planOf(inject: InjectRoute, ref: string) {
  const chat = await findChat(inject, ref);
  const plan = (await readTree(inject, chat.id)).split;
  if (!plan) throw new Error(`Chat «${maskedTitle(chat)}» has no split plan in its tree.`);
  return { chat, plan };
}

function groupOf(plan: SplitPlanView, wanted: number | string): PlanGroup {
  const found =
    typeof wanted === 'number'
      ? plan.groups.find((group) => group.index === wanted)
      : plan.groups.find(
          (group) => group.title.trim().toLowerCase() === wanted.trim().toLowerCase(),
        );
  if (!found) {
    throw new Error(
      `No split group «${wanted}»; groups: ${plan.groups.map((group) => `${group.index} ${maskedTitle(group)}`).join(', ')}.`,
    );
  }
  return found;
}

const groupRef = z
  .union([z.number().int().min(0), z.string().min(1)])
  .describe('Group index (from read_chat split.groups) or exact title');

const titles = (plan: SplitPlanView) =>
  Object.fromEntries(plan.groups.map((group) => [group.index, maskedTitle(group)]));

/** План вызова — между `route` и `shape`. */
const planFor = new WeakMap<object, SplitPlanView>();

const readSplitOverlap = definePanelAction({
  name: 'read_split_overlap',
  section: 'chat',
  risk: 'read',
  description:
    'Files touched by more than one group of a split (and by groups outside their declared ' +
    'ownership), the suggested merge order and branches that could not be read — the hub’s ' +
    '«Пересечения» check. It recomputes exactly what opening that check does: the result is ' +
    'saved on the split and a newly found overlap is announced once in the parent chat. No ' +
    'branch, file or group is changed; merging stays with the human.',
  input: z.object({
    chat: chatRef.describe('The chat that asked for the split (or any chat of its tree)'),
  }),
  route: async (input, inject) => {
    const { chat, plan } = await planOf(inject, input.chat);
    chatOf.set(input, chat);
    planFor.set(input, plan);
    return {
      method: 'GET',
      url: `/api/chat/split/${encode(plan.parentChatId)}/overlap`,
    };
  },
  shape: (input, body) => {
    const view = body as SplitOverlapView;
    const plan = planFor.get(input);
    return maskResult({
      at: view.at,
      groups: plan ? titles(plan) : undefined,
      files: view.files.slice(0, 100),
      ...(view.files.length > 100 ? { filesTotal: view.files.length } : {}),
      mergeOrder: view.mergeOrder,
      counted: view.counted.map(({ index, files }) => ({ index, files })),
      unread: view.unread,
    });
  },
  summary: 'journal-read-split-overlap',
});

const acceptInput = z.object({
  chat: chatRef.describe('The chat that asked for the split (or any chat of its tree)'),
  group: groupRef,
  accepted: z
    .boolean()
    .default(true)
    .describe('true = mark a delivered group accepted; false = remove the mark'),
});
type AcceptInput = z.infer<typeof acceptInput>;

async function acceptTarget(inject: InjectRoute, input: AcceptInput) {
  const { chat, plan } = await planOf(inject, input.chat);
  if (plan.cancelledAt) throw new Error('This split plan was cancelled by the human.');
  const group = groupOf(plan, input.group);
  if (input.accepted && group.status !== 'done') {
    throw new Error(
      `Group «${maskedTitle(group)}» is not delivered yet (status ${group.status}): only a done group is accepted.`,
    );
  }
  if (input.accepted === Boolean(group.acceptedAt)) {
    throw new Error(
      `Nothing would change: group «${maskedTitle(group)}» is ${group.acceptedAt ? 'already' : 'not'} accepted.`,
    );
  }
  return { chat, plan, group };
}

const splitAcceptGroup = definePanelAction({
  name: 'split_accept_group',
  section: 'chat',
  risk: 'change',
  title: 'journal-split-accept-group',
  description:
    'Mark a delivered (done) split group accepted — the hub’s «Принять» — or remove the mark ' +
    '(accepted=false, «Снять отметку»). Only the plan’s mark changes; branch, copy and chat stay. ' +
    'Needs the human’s confirmation.',
  input: acceptInput,
  route: async (input, inject) => {
    const { chat, plan, group } = await acceptTarget(inject, input);
    chatOf.set(input, chat);
    return {
      method: 'POST',
      url: `/api/chat/split/${encode(plan.parentChatId)}/accept`,
      body: { index: group.index, accepted: input.accepted },
    };
  },
  fingerprint: async (input, inject) => {
    const { plan, group } = await acceptTarget(inject, input);
    return fingerprintOf({
      parent: plan.parentChatId,
      index: group.index,
      status: group.status,
      acceptedAt: group.acceptedAt,
    });
  },
  preview: async (input, inject) => {
    const { chat, group } = await acceptTarget(inject, input);
    return {
      ...summaryText(input.accepted ? 'summary-split-accept' : 'summary-split-unaccept', {
        chat: maskedTitle(chat),
        group: maskedTitle(group),
      }),
      fields: [
        chatField(chat),
        dataField('label-group', `${group.index} — ${maskedTitle(group)}`),
        textField(
          'label-what-happens',
          input.accepted ? 'value-split-accept-effect' : 'value-split-unaccept-effect',
        ),
      ],
    };
  },
  shape: (_input, body) => {
    const answer = body as { index: number; acceptedAt?: string };
    return {
      index: answer.index,
      accepted: Boolean(answer.acceptedAt),
      acceptedAt: answer.acceptedAt,
    };
  },
  page: (input) => chatPage(input),
});

const resumeInput = z.object({
  chat: chatRef.describe('The chat that asked for the split (or any chat of its tree)'),
  group: groupRef.optional().describe('One interrupted group; omit = every interrupted group'),
});
type ResumeInput = z.infer<typeof resumeInput>;

const isInterrupted = (group: PlanGroup): boolean =>
  group.status === 'awaiting' && group.waitingFor === 'interrupted';

async function resumeTarget(inject: InjectRoute, input: ResumeInput) {
  const { chat, plan } = await planOf(inject, input.chat);
  if (plan.cancelledAt) throw new Error('This split plan was cancelled by the human.');
  const one = input.group === undefined ? undefined : groupOf(plan, input.group);
  if (one && !isInterrupted(one)) {
    throw new Error(
      `Group «${maskedTitle(one)}» was not interrupted (status ${one.status}); nothing to resume.`,
    );
  }
  const groups = one ? [one] : plan.groups.filter(isInterrupted);
  if (groups.length === 0) {
    throw new Error('No group of this split was interrupted: nothing to resume.');
  }
  return { chat, plan, one, groups };
}

const splitResumeInterrupted = definePanelAction({
  name: 'split_resume_interrupted',
  section: 'chat',
  risk: 'change',
  title: 'journal-split-resume-interrupted',
  description:
    'Resume split groups whose process died mid-turn (panel restart, machine off, CLI crash) — ' +
    'the hub’s «Продолжить» for interrupted groups: one group or all of them. Each continues its ' +
    'own session; spends subscription turns. Not for paused groups (split_control). Needs the ' +
    'human’s confirmation.',
  input: resumeInput,
  route: async (input, inject) => {
    const { chat, plan, one } = await resumeTarget(inject, input);
    chatOf.set(input, chat);
    return {
      method: 'POST',
      url: `/api/chat/split/${encode(plan.parentChatId)}/resume`,
      body: one ? { index: one.index } : {},
    };
  },
  fingerprint: async (input, inject) => {
    const { plan, groups } = await resumeTarget(inject, input);
    return fingerprintOf({
      parent: plan.parentChatId,
      groups: groups.map((group) => ({ index: group.index, at: group.interruptedAt })),
    });
  },
  preview: async (input, inject) => {
    const { chat, groups } = await resumeTarget(inject, input);
    return {
      ...summaryText('summary-split-resume-interrupted', { chat: maskedTitle(chat) }),
      fields: [
        chatField(chat),
        dataField(
          'label-split-interrupted-groups',
          groups.map((group) => `${group.index} — ${maskedTitle(group)}`).join(', '),
        ),
        textField('label-what-happens', 'value-split-resume-interrupted-effect'),
      ],
    };
  },
  shape: (_input, body) => {
    const answer = body as { resumed: number[]; refused: number[] };
    return {
      resumed: answer.resumed,
      refused: answer.refused,
      ...(answer.refused.length
        ? { note: 'Refused groups could not be restarted (no chat or copy); tell the human.' }
        : {}),
    };
  },
  page: (input) => chatPage(input),
});

/** Действия чата дорожки A в порядке показа. */
export const GAPS_CHAT_ACTIONS: readonly AnyPanelAction[] = [
  readChatModes,
  readChatSpend,
  requestChatHandoff,
  readModelCascade,
  setModelCascade,
  listLoweredRuns,
  readSplitOverlap,
  splitAcceptGroup,
  splitResumeInterrupted,
];
