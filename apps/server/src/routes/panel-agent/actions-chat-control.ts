import { z } from 'zod';
import type { ChatSummary, Group } from '@agentdeck/contracts';
import type { ChatGroupSettingsView } from '@agentdeck/contracts/chat-group-settings';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import {
  groupKeyOf,
  isForeignGlobal,
  parseGroupKey,
  scopeOf,
} from '@agentdeck/contracts/group-sources';
import type { PanelActionPreviewField } from '@agentdeck/contracts/panel-agent';
import { encode, readRoute, stateCard } from './action-kit.ts';
import {
  assertClaudeChat,
  chatField,
  chatProject,
  chatEdits,
  chatSendPlan,
  continueBody,
  findChat,
  maskedTitle,
  planFields,
  readTree,
  runningOf,
  samePath,
  sendOutcome,
  sendRefusal,
  stateField,
  type ActiveRun,
} from './actions-chat-kit.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from './registry.ts';
import { dataField, summaryText, textField } from './texts.ts';

/**
 * Правки агента в чатах (U1): написать в чат, попросить разделение, «работать
 * здесь», группа и автономность чата, стоп, пульт разделения и дерева. Каждая —
 * тем же маршрутом, что кнопка окна чата, и только по карточке человека.
 *
 * Чего здесь нет намеренно (решает человек): применить разделение, отменить
 * план, убрать копии, решения по правам и воротам ветки, автоподтверждение и
 * `force` сверх потолка очереди.
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

// ── request_split ─────────────────────────────────────────────────────────

/** Просьба о разделении — текст сервера, тот же, что у кнопки чата. */
async function splitPrompt(inject: InjectRoute, chat: ChatSummary): Promise<string> {
  const plan = await chatSendPlan(inject, chat);
  const query = new URLSearchParams({
    path: chatProject(chat) ?? '',
    ...(plan.model ? { model: plan.model } : {}),
    ...(plan.effort ? { effort: plan.effort } : {}),
  });
  const answer = await readRoute<{ prompt: string }>(
    inject,
    `/api/chat/split/request?${query.toString()}`,
  );
  return answer.prompt;
}

/** Разделение заводит группам git-копии проекта — у чата в панели проекта нет. */
function assertSplittable(chat: ChatSummary): void {
  if (chat.isSandbox) {
    throw new Error(
      'This chat lives in the panel itself, without a project: a split gives every group a git ' +
        'copy of a project, so there is nothing to split here.',
    );
  }
}

const requestSplit = definePanelAction({
  name: 'request_split',
  section: 'chat',
  risk: 'danger',
  title: 'journal-request-split',
  description:
    'Ask the agent of a project chat to propose splitting its tasks into separate chats — the ' +
    'same request as the chat’s «Разделить задачи по чатам» button. The chat agent answers with ' +
    'a proposal; the HUMAN then presses «Разделить на N чата» under it (you never apply a split). ' +
    'Needs the human’s confirmation.',
  input: z.object({ chat: chatRef }),
  route: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    assertSplittable(chat);
    await assertClaudeChat(inject, 'request_split');
    chatOf.set(input, chat);
    const plan = await chatSendPlan(inject, chat);
    return {
      method: 'POST',
      url: '/api/chat/send',
      stream: true,
      body: continueBody(chat, await splitPrompt(inject, chat), plan, false),
    };
  },
  fingerprint: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    return fingerprintOf({
      chat: chat.id,
      project: chat.projectPath,
      plan: await chatSendPlan(inject, chat),
      prompt: await splitPrompt(inject, chat),
    });
  },
  // Карточка называет просьбу, а не её текст: он служебный (формат ответа для
  // агента), и человек одобряет то же, что делает его кнопка.
  preview: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    assertSplittable(chat);
    await assertClaudeChat(inject, 'request_split');
    const plan = await chatSendPlan(inject, chat);
    const busy = Boolean(await runningOf(inject, chat.id));
    return {
      ...summaryText('summary-request-split', { chat: maskedTitle(chat) }),
      fields: [
        chatField(chat),
        ...planFields(plan),
        stateField(busy),
        textField('label-message', 'value-split-request-standard'),
        textField('label-what-happens', 'value-split-next-human'),
      ],
    };
  },
  refusal: sendRefusal,
  shape: (input, body) => {
    const chat = chatOf.get(input);
    return {
      ...(chat ? sendOutcome(chat, body) : { sent: true }),
      next:
        'When the chat agent answers, its proposal appears in that chat with the «Разделить на N ' +
        'чата» button. Only the human presses it; read_chat shows the proposal.',
    };
  },
  page: (input) => chatPage(input),
});

// ── split_decline ─────────────────────────────────────────────────────────

const splitDecline = definePanelAction({
  name: 'split_decline',
  section: 'chat',
  risk: 'change',
  title: 'journal-split-decline',
  description:
    'Stop a chat agent from proposing a split again («работать здесь»): the split initiative ' +
    'goes quiet for that chat; the human’s split button keeps working. The chat’s own ' +
    '«Работаем здесь» also tells the agent — if the human wants that, follow up with ' +
    'send_chat_message "Не разделяй — делай всё здесь, по очереди."',
  input: z.object({ chat: chatRef }),
  route: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    chatOf.set(input, chat);
    return { method: 'POST', url: '/api/chat/split/decline', body: { chatId: chat.id } };
  },
  fingerprint: async (input, inject) => fingerprintOf((await findChat(inject, input.chat)).id),
  preview: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    return {
      ...summaryText('summary-split-decline', { chat: maskedTitle(chat) }),
      fields: [chatField(chat), textField('label-what-happens', 'value-split-decline-effect')],
    };
  },
  shape: (input) => ({ declined: true, chatId: chatOf.get(input)?.id }),
});

// ── set_chat_group ────────────────────────────────────────────────────────

type OwnSettings = { groupChoice?: string; autonomous?: boolean };

const ownOf = (view: ChatGroupSettingsView): OwnSettings => ({
  ...(view.groupChoiceInherited ? {} : { groupChoice: view.groupChoice }),
  ...(view.autonomousInherited ? {} : { autonomous: view.autonomous }),
});

const groupSettingsUrl = (chat: ChatSummary): string =>
  `/api/chat/${encode(chat.id)}/group-settings`;

/**
 * Группа для чата — как у меню группы в шапке чата: глобальная Claude или
 * проектная ЕГО проекта. Имя, id или ключ `global:`/`project:`.
 */
function resolveGroup(groups: readonly Group[], chat: ChatSummary, wanted: string): string {
  const project = chatProject(chat);
  const usable = groups.filter((group) => {
    if (isForeignGlobal(group.scope)) return false;
    const scope = scopeOf(group);
    return scope.kind === 'global' || (project ? samePath(scope.path, project) : false);
  });
  const lower = wanted.trim().toLowerCase();
  const matches = usable.filter(
    (group) =>
      groupKeyOf(group) === wanted.trim() ||
      group.id === wanted.trim() ||
      group.name.trim().toLowerCase() === lower,
  );
  const [only] = matches;
  if (only && matches.length === 1) return groupKeyOf(only);
  if (matches.length > 1) {
    throw new Error(
      `Several groups match «${wanted}»: ${matches.map((group) => groupKeyOf(group)).join(', ')}. Pass the key.`,
    );
  }
  const elsewhere = groups.some(
    (group) => group.id === wanted.trim() || group.name.trim().toLowerCase() === lower,
  );
  throw new Error(
    elsewhere
      ? `Group «${wanted}» does not act in this chat: only global Claude groups and groups of ` +
          'the chat’s own project do.'
      : `Group «${wanted}» not found; list_groups names them.`,
  );
}

const setGroupInput = z
  .object({
    chat: chatRef,
    group: z
      .string()
      .min(1)
      .optional()
      .describe('"auto", "inherit" (as the parent chat), or a group name / id / key'),
    autonomous: z
      .union([z.boolean(), z.literal('inherit')])
      .optional()
      .describe('Autonomy: agents pick the recommended answer themselves; "inherit" = as parent'),
  })
  .refine((input) => input.group !== undefined || input.autonomous !== undefined, {
    message: 'Pass group, autonomous or both',
  });

interface GroupPlan {
  chat: ChatSummary;
  view: ChatGroupSettingsView;
  next: OwnSettings;
  groups: Group[];
}

async function groupPlan(
  input: z.infer<typeof setGroupInput>,
  inject: InjectRoute,
): Promise<GroupPlan> {
  const chat = await findChat(inject, input.chat);
  const view = await readRoute<ChatGroupSettingsView>(inject, groupSettingsUrl(chat));
  const groups = await readRoute<Group[]>(inject, '/api/groups');
  const next: OwnSettings = { ...ownOf(view) };
  if (input.group !== undefined) {
    const wanted = input.group.trim();
    if (wanted === 'inherit') delete next.groupChoice;
    else if (wanted === 'auto') next.groupChoice = 'auto';
    else next.groupChoice = resolveGroup(groups, chat, wanted);
  }
  if (input.autonomous === 'inherit') delete next.autonomous;
  else if (input.autonomous !== undefined) next.autonomous = input.autonomous;
  return { chat, view, next, groups };
}

/** Название выбора для глаз человека: «Авто», имя группы или ключ пропавшей. */
function choiceLabel(groups: readonly Group[], choice: string | undefined): string {
  if (choice === undefined) return 'inherit';
  if (choice === 'auto') return 'auto';
  const found = groups.find((group) => groupKeyOf(group) === choice);
  return found ? `${found.name} (${choice})` : choice;
}

const setChatGroup = definePanelAction({
  name: 'set_chat_group',
  section: 'chat',
  risk: 'change',
  title: 'journal-set-chat-group',
  description:
    'Set a chat’s group (the set of skills, rules and steps its runs follow: "auto" lets the ' +
    'triage pick, a name pins one) and/or its autonomy — as the chat header menu does. Takes ' +
    'effect from the chat’s next turn. Needs the human’s confirmation.',
  input: setGroupInput,
  route: async (input, inject) => {
    const plan = await groupPlan(input, inject);
    const project = chatProject(plan.chat);
    return {
      method: 'PUT',
      url: `${groupSettingsUrl(plan.chat)}${project ? `?projectPath=${encode(project)}` : ''}`,
      body: plan.next,
    };
  },
  fingerprint: async (input, inject) => {
    const plan = await groupPlan(input, inject);
    return fingerprintOf({ chat: plan.chat.id, own: ownOf(plan.view), next: plan.next });
  },
  preview: async (input, inject) => {
    const plan = await groupPlan(input, inject);
    const own = ownOf(plan.view);
    const shown = (settings: OwnSettings) => ({
      group: choiceLabel(plan.groups, settings.groupChoice),
      autonomous: settings.autonomous ?? 'inherit',
    });
    const fields: PanelActionPreviewField[] = [chatField(plan.chat)];
    if (input.group !== undefined) {
      const choice = plan.next.groupChoice;
      fields.push(
        choice === undefined
          ? textField('label-group', 'value-group-inherit')
          : choice === 'auto'
            ? textField('label-group', 'value-group-auto')
            : dataField('label-group', choiceLabel(plan.groups, choice)),
      );
    }
    if (input.autonomous !== undefined) {
      const value = plan.next.autonomous;
      fields.push(
        textField(
          'label-autonomous',
          value === undefined
            ? 'value-autonomous-inherit'
            : value
              ? 'value-autonomous-on'
              : 'value-autonomous-off',
        ),
      );
    }
    return stateCard(
      'chat group settings',
      shown(own),
      shown(plan.next),
      summaryText('summary-set-chat-group', { chat: maskedTitle(plan.chat) }),
      fields,
    );
  },
  shape: (_input, body) => {
    const view = body as ChatGroupSettingsView;
    const key = parseGroupKey(view.groupChoice);
    return {
      group: view.groupChoice,
      ...(key ? { groupScope: key.kind } : {}),
      autonomous: view.autonomous,
      note: 'Applies from the chat’s next turn.',
    };
  },
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
    'Stop the running agent of a chat, like its Stop button: the turn is cut short. A split ' +
    'group’s chat pauses its group (resume with split_control). Needs the human’s confirmation.',
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
    const inGroup = target.chat?.groupIndex !== undefined && Boolean(target.chat?.parentId);
    return {
      ...summaryText('summary-stop-chat-run', { chat: target.title }),
      fields: [
        target.chat ? chatField(target.chat) : dataField('label-chat', target.title),
        textField('label-what-happens', 'value-stop-run'),
        ...(inGroup ? [textField('label-what-happens', 'value-stop-pauses-group')] : []),
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

const SPLIT_MODES = [
  'pause_group',
  'resume_group',
  'release_group',
  'answer_group',
  'pause_all',
  'resume_all',
] as const;
type SplitMode = (typeof SPLIT_MODES)[number];

const splitControlInput = z.object({
  chat: chatRef.describe('The chat that asked for the split (or any chat of its tree)'),
  mode: z
    .enum(SPLIT_MODES)
    .describe(
      'pause_group / resume_group — one group; release_group — start a group waiting for its ' +
        'predecessors now; answer_group — the human’s answer to a group’s triage question; ' +
        'pause_all / resume_all — every run of the whole tree',
    ),
  group: z
    .union([z.number().int().min(0), z.string().min(1)])
    .optional()
    .describe('Group index (from read_chat split.groups) or exact title; group modes only'),
  answer: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .optional()
    .describe('answer_group: the human’s own answer'),
});
type SplitControlInput = z.infer<typeof splitControlInput>;

type PlanGroup = SplitPlanView['groups'][number];

interface SplitTarget {
  chat: ChatSummary;
  paused: boolean;
  plan?: SplitPlanView;
  group?: PlanGroup;
}

const isGroupMode = (mode: SplitMode): boolean => !mode.endsWith('_all');

function pickGroup(plan: SplitPlanView, wanted: number | string): PlanGroup {
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

async function splitTarget(input: SplitControlInput, inject: InjectRoute): Promise<SplitTarget> {
  const chat = await findChat(inject, input.chat);
  const tree = await readTree(inject, chat.id);
  const paused = Boolean(tree.paused);
  if (!isGroupMode(input.mode)) {
    if (input.mode === 'pause_all' && paused) {
      throw new Error('Nothing would change: this tree is already paused.');
    }
    if (input.mode === 'resume_all' && !paused) {
      throw new Error('Nothing would change: this tree is not paused.');
    }
    return { chat, paused, ...(tree.split ? { plan: tree.split } : {}) };
  }
  const plan = tree.split;
  if (!plan) throw new Error(`Chat «${maskedTitle(chat)}» has no split plan in its tree.`);
  if (plan.cancelledAt) throw new Error('This split plan was cancelled by the human.');
  if (input.group === undefined) throw new Error(`Mode ${input.mode} needs group.`);
  const group = pickGroup(plan, input.group);
  if (input.mode === 'answer_group') {
    if (!group.hold || group.holdAnswer) {
      throw new Error(`Group «${maskedTitle(group)}» has no open triage question.`);
    }
    if (!input.answer) throw new Error('answer_group needs answer — the human’s own words.');
  }
  return { chat, paused, plan, group };
}

const MODE_ROUTE: Record<SplitMode, string> = {
  pause_group: 'pause',
  resume_group: 'resume-paused',
  release_group: 'release',
  answer_group: 'hold',
  pause_all: 'pause',
  resume_all: 'resume',
};

const MODE_SUMMARY = {
  pause_group: 'summary-split-pause',
  resume_group: 'summary-split-resume',
  release_group: 'summary-split-release',
  answer_group: 'summary-split-answer',
  pause_all: 'summary-tree-pause',
  resume_all: 'summary-tree-resume',
} as const;

const MODE_EFFECT = {
  pause_group: 'value-split-pause-effect',
  resume_group: 'value-split-resume-effect',
  release_group: 'value-split-release-effect',
  answer_group: 'value-split-answer-effect',
  pause_all: 'value-tree-pause-effect',
  resume_all: 'value-tree-resume-effect',
} as const;

/**
 * Что будет — по тому, где группа стоит, а не только по режиму: карточка
 * обязана сказать правду (ревью 29.09, A14 и N7). Пауза из очереди места не
 * держит, и «Продолжить» вернёт её в очередь; у группы, чья копия ещё
 * готовилась, сессии нет, и она стартует в копии; у группы из очереди нет
 * прогонов, которые пауза остановила бы.
 */
export function controlEffect(
  mode: keyof typeof MODE_EFFECT,
  group: { status: string; seated?: boolean; chatId?: string } | undefined,
) {
  if (mode === 'resume_group' && group?.status === 'paused') {
    if (!group.seated) return 'value-split-requeue-effect';
    if (!group.chatId) return 'value-split-resume-fresh-effect';
  }
  if (mode === 'pause_group' && group && !group.seated && !group.chatId) {
    return 'value-split-pause-queued-effect';
  }
  return MODE_EFFECT[mode];
}

const splitControl = definePanelAction({
  name: 'split_control',
  section: 'chat',
  risk: 'change',
  title: 'journal-split-control',
  description:
    'Control a running split, as its hub does: pause / resume one group, release a group ' +
    'waiting for its predecessors, pass the human’s answer to a group’s triage question, or ' +
    'pause / resume the whole tree. Resume never forces past the parallel limit: a refusal ' +
    'about the limit means ask the human. Applying, cancelling a split and cleaning copies stay ' +
    'with the human. Needs the human’s confirmation.',
  input: splitControlInput,
  route: async (input, inject) => {
    const target = await splitTarget(input, inject);
    chatOf.set(input, target.chat);
    if (!target.group || !target.plan) {
      return {
        method: 'POST',
        url: `/api/chat/${encode(target.chat.id)}/tree/${MODE_ROUTE[input.mode]}`,
        body: {},
      };
    }
    return {
      method: 'POST',
      url: `/api/chat/split/${encode(target.plan.parentChatId)}/${MODE_ROUTE[input.mode]}`,
      body: {
        index: target.group.index,
        ...(input.mode === 'answer_group' ? { answer: input.answer } : {}),
      },
    };
  },
  fingerprint: async (input, inject) => {
    const target = await splitTarget(input, inject);
    return fingerprintOf({
      chat: target.chat.id,
      mode: input.mode,
      paused: target.paused,
      parent: target.plan?.parentChatId,
      group: target.group
        ? {
            index: target.group.index,
            status: target.group.status,
            hold: target.group.hold,
            holdAnswer: target.group.holdAnswer,
          }
        : null,
      answer: input.answer,
    });
  },
  preview: async (input, inject) => {
    const target = await splitTarget(input, inject);
    const fields: PanelActionPreviewField[] = [chatField(target.chat)];
    if (target.group) {
      fields.push(dataField('label-group', `${target.group.index} — ${maskedTitle(target.group)}`));
    }
    if (input.mode === 'answer_group' && target.group?.hold) {
      fields.push(dataField('label-question', target.group.hold));
      fields.push(dataField('label-answer', input.answer ?? ''));
    }
    fields.push(textField('label-what-happens', controlEffect(input.mode, target.group)));
    return {
      ...summaryText(MODE_SUMMARY[input.mode], {
        chat: maskedTitle(target.chat),
        ...(target.group ? { group: maskedTitle(target.group) } : {}),
      }),
      fields,
    };
  },
  page: (input) => chatPage(input),
});

/** Правки раздела «Чат» (U1) в порядке показа. */
export const CHAT_CONTROL_ACTIONS: readonly AnyPanelAction[] = [
  sendChatMessage,
  requestSplit,
  splitDecline,
  setChatGroup,
  stopChatRun,
  splitControl,
];
