import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  AppSettings,
  ChatSummary,
  PlatformRunPlan,
  Project,
  ProvidersResponse,
} from '@agentdeck/contracts';
import { chooseRunModel } from '@agentdeck/contracts/platform-models';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
  type StreamHead,
} from './registry.ts';
import { dataField, summaryText, textField } from './texts.ts';
import { codeOf } from '../../lib/server-text.ts';

/**
 * Действия раздела «Проекты, чат» (А4): чаты, идущие прогоны и новый чат с
 * первым сообщением. Всё исполняется маршрутами, которые зовёт окно чата;
 * здесь только проекция ответа для модели и честная карточка.
 */

/** Сколько чатов отдавать модели по умолчанию: список всей машины — сотни строк. */
const CHATS_DEFAULT_LIMIT = 20;

/** Ответ маршрута чтения или исключение с его текстом: карточка без данных — отказ. */
async function readRoute<T>(inject: InjectRoute, url: string): Promise<T> {
  const answer = await inject({ method: 'GET', url });
  if (answer.status >= 400) {
    const message = (answer.body as { message?: string } | undefined)?.message;
    throw new Error(`${url} answered ${answer.status}${message ? `: ${message}` : ''}`);
  }
  return answer.body as T;
}

/** Проект реестра по id или абсолютному пути — тот, что увидит человек в списке. */
export async function findProject(inject: InjectRoute, ref: string): Promise<Project> {
  const projects = await readRoute<Project[]>(inject, '/api/projects');
  const wanted = ref.trim();
  const byPath = resolve(wanted).toLowerCase();
  const project = projects.find(
    (item) => item.id === wanted || resolve(item.path).toLowerCase() === byPath,
  );
  if (!project) {
    throw new Error(`Project «${wanted}» is not registered. Call list_projects or create_project.`);
  }
  return project;
}

/**
 * Чем пойдёт первый прогон. Тем же расчётом, что шапка чата
 * (`useRunModelName`): модель чата или настройки, через контур — перевод
 * `chooseRunModel` по правилам маршрута `platform-run-plan`. Третьего расчёта нет.
 */
interface ChatRunPlan {
  providerId: string;
  providerName: string;
  /** Что уйдёт в тело `model`: выбор агента или модель чата из настроек. */
  asked: string;
  /** Чем ответит модель на деле; пусто — решит CLI. */
  model: string;
  contour?: string;
  contourNote?: string;
}

async function chatRunPlan(inject: InjectRoute, asked: string | undefined): Promise<ChatRunPlan> {
  const providers = await readRoute<ProvidersResponse>(inject, '/api/providers');
  const provider = providers.providers.find((item) => item.id === providers.active);
  // Чат с чужим CLI живёт в другом разделе и другом маршруте: отправить его
  // запрос в маршрут Claude значило бы запустить чужой бинарь с флагами Claude.
  if (providers.active !== 'claude') {
    throw new Error(
      `start_chat supports only the Claude provider; the active one is «${providers.active}».`,
    );
  }
  const settings = await readRoute<AppSettings>(inject, '/api/settings');
  const wanted = asked?.trim() || settings.chatModel || '';
  const plan = await readRoute<PlatformRunPlan>(inject, '/api/platform-run-plan/chat');
  const base = {
    providerId: providers.active,
    providerName: provider?.name ?? providers.active,
    asked: wanted,
  };
  if (plan.routed) {
    return {
      ...base,
      model: chooseRunModel(plan.rules, wanted).model,
      contour: plan.title,
    };
  }
  const contourNote = plan.refused
    ? `contour «${plan.title}» will refuse the run (${plan.reason ?? 'unavailable'})`
    : plan.bypassed
      ? `contour «${plan.title}» is down, the run goes to the vendor cloud (${plan.reason ?? ''})`
      : undefined;
  return { ...base, model: wanted, ...(contourNote ? { contourNote } : {}) };
}

const listChats = definePanelAction({
  name: 'list_chats',
  section: 'projects',
  risk: 'read',
  description:
    'List CLI chats, newest first (id, title, project path, updatedAt, model). ' +
    'Filter by project path; default limit 20.',
  input: z.object({
    projectPath: z.string().trim().min(1).optional().describe('Absolute project directory'),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  route: () => ({ method: 'GET', url: '/api/chats' }),
  // Проекция, а не пересказ: те же строки, что в списке чата, без превью и
  // счётчиков — модели хватает, чтобы назвать разговор и открыть его.
  shape: (input, body) => {
    const wanted = input.projectPath ? resolve(input.projectPath).toLowerCase() : undefined;
    const chats = (Array.isArray(body) ? (body as ChatSummary[]) : [])
      .filter((chat) => !wanted || resolve(chat.projectPath).toLowerCase() === wanted)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const limit = input.limit ?? CHATS_DEFAULT_LIMIT;
    return {
      total: chats.length,
      chats: chats.slice(0, limit).map((chat) => ({
        id: chat.id,
        title: chat.title,
        projectPath: chat.projectPath,
        updatedAt: chat.updatedAt,
        messages: chat.messageCount,
        ...(chat.model ? { model: chat.model } : {}),
        ...(chat.parentId ? { parentId: chat.parentId } : {}),
        ...(chat.awaitingReply ? { awaitingReply: true } : {}),
      })),
    };
  },
  summary: 'journal-list-chats',
});

const listActiveRuns = definePanelAction({
  name: 'list_active_runs',
  section: 'chat',
  risk: 'read',
  description:
    'Chat runs going on right now (chatId, sessionId, projectPath, status running|done, model).',
  input: z.object({}),
  route: () => ({ method: 'GET', url: '/api/chat/active' }),
  summary: 'journal-list-active-runs',
});

const startChatInput = z.object({
  project: z.string().trim().min(1).describe('Project id or absolute path from list_projects'),
  prompt: z.string().trim().min(1).max(20_000).describe('First message of the new chat'),
  model: z.string().trim().max(200).optional().describe('Model; default = chat model in settings'),
  allowEdits: z
    .boolean()
    .optional()
    .describe('Let the chat agent edit project files; default false (read-only)'),
});

const startChat = definePanelAction({
  name: 'start_chat',
  section: 'projects',
  risk: 'danger',
  title: 'journal-start-chat',
  description:
    'Start a NEW chat in a registered project with a first message: launches a CLI agent run. ' +
    'Needs the human’s confirmation. Returns the sessionId once the CLI names it.',
  input: startChatInput,
  // Тело — то, что шлёт окно чата при первом сообщении нового разговора:
  // временный ключ `new-…`, каталог проекта, модель шапки (или настройки).
  route: async (input, inject) => {
    const project = await findProject(inject, input.project);
    const plan = await chatRunPlan(inject, input.model);
    return {
      method: 'POST',
      url: '/api/chat/send',
      stream: true,
      body: {
        chatId: `new-${Date.now()}`,
        prompt: input.prompt,
        projectPath: project.path,
        ...(plan.asked ? { model: plan.asked } : {}),
        allowEdits: input.allowEdits === true,
      },
    };
  },
  // Отпечаток — проект и план прогона (провайдер, модель из настроек, контур):
  // сменили модель по умолчанию после карточки — запустилась бы не названная.
  fingerprint: async (input, inject) =>
    fingerprintOf({
      project: await findProject(inject, input.project),
      plan: await chatRunPlan(inject, input.model),
    }),
  preview: async (input, inject) => {
    const project = await findProject(inject, input.project);
    const plan = await chatRunPlan(inject, input.model);
    // Промпт целиком (вход ограничен 20 000 символов): хвост, обрезанный ради
    // вида карточки, запустил бы агента с текстом, которого человек не читал.
    const prompt = input.prompt;
    return {
      ...summaryText('summary-start-chat', { project: project.name }),
      fields: [
        dataField('label-project', `${project.name} — ${project.path}`),
        dataField('label-provider', plan.providerName),
        plan.model
          ? dataField('label-model', plan.model)
          : textField('label-model', 'value-model-default'),
        ...(plan.contour ? [dataField('label-contour', plan.contour)] : []),
        ...(plan.contourNote ? [dataField('label-contour', plan.contourNote)] : []),
        textField(
          'label-file-edits',
          input.allowEdits === true ? 'value-edits-allowed' : 'value-edits-denied',
        ),
        dataField('label-first-message', prompt),
      ],
    };
  },
  // Модели — начало прогона, а не весь поток: имя сессии, модель и отказ, если был.
  shape: (_input, body) => {
    const head = body as StreamHead;
    const session = head.frames.find((frame) => frame.kind === 'session');
    const error = head.frames.find((frame) => frame.kind === 'error');
    return {
      started: !error,
      ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
      ...(session?.model ? { model: session.model } : {}),
      ...(error?.message ? { error: error.message, ...codeOf(error) } : {}),
      ...(head.timedOut && !session
        ? { note: 'The CLI has not named the session yet; see list_active_runs.' }
        : {}),
    };
  },
  page: (_input, result) => {
    const sessionId = (result as { sessionId?: unknown }).sessionId;
    return { route: '/chat', ...(typeof sessionId === 'string' ? { focus: sessionId } : {}) };
  },
});

/** Действия раздела «Проекты, чат» в порядке показа. */
export const PROJECT_CHAT_ACTIONS: readonly AnyPanelAction[] = [
  listChats,
  listActiveRuns,
  startChat,
];
