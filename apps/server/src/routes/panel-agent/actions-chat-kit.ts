import { resolve } from 'node:path';
import type {
  AppSettings,
  ChatAutoModeView,
  ChatSummary,
  ProvidersResponse,
} from '@agentdeck/contracts';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import type { PanelActionPreviewField } from '@agentdeck/contracts/panel-agent';
import { encode, readRoute, routeError } from './action-kit.ts';
import type { InjectRoute, StreamHead } from './registry.ts';
import { dataField, textField } from './texts.ts';

/**
 * Общее у действий над чатами: найти разговор так, как его видит список чатов,
 * узнать, идёт ли в нём прогон, и собрать то, с чем уйдёт сообщение, — тем же
 * расчётом, что у поля ввода чата (`useChatModelPrefs`, `useChatSend`).
 */

/** Прогон из `/api/chat/active` — поля, которые нужны действиям. */
export interface ActiveRun {
  chatId: string;
  sessionId?: string;
  projectPath?: string;
  startedAt?: number;
  status: 'running' | 'done';
}

/**
 * Чат списка по id или по точному названию. Название — ради просьбы «открой
 * чат "…"»: модель чаще знает его, чем id. Два чата с одним названием —
 * отказ со списком id, а не угаданный первый: сообщение ушло бы не туда.
 */
export async function findChat(inject: InjectRoute, ref: string): Promise<ChatSummary> {
  const chats = await readRoute<ChatSummary[]>(inject, '/api/chats');
  const wanted = ref.trim();
  const byId = chats.find((chat) => chat.id === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const byTitle = chats.filter((chat) => chat.title.trim().toLowerCase() === lower);
  if (byTitle.length === 1 && byTitle[0]) return byTitle[0];
  if (byTitle.length > 1) {
    throw new Error(
      `Several chats are titled «${wanted}»: ${byTitle.map((chat) => chat.id).join(', ')}. Pass the id.`,
    );
  }
  throw new Error(
    `Chat «${wanted}» not found. Take its id from list_chats or search_chats (a running chat ` +
      'without a transcript yet is in list_active_runs).',
  );
}

/** Идущий прогон чата: по ключу реестра или по имени сессии. */
export async function runningOf(inject: InjectRoute, ref: string): Promise<ActiveRun | undefined> {
  const runs = await readRoute<ActiveRun[]>(inject, '/api/chat/active');
  return runs.find(
    (run) => run.status === 'running' && (run.chatId === ref || run.sessionId === ref),
  );
}

/** Название чата для глаз модели: его пишет первое сообщение, в нём бывает ключ. */
export const maskedTitle = (chat: Pick<ChatSummary, 'title'>): string =>
  maskSecretsInText(chat.title);

/** Строка карточки «Чат»: название и где он живёт. */
export function chatField(chat: ChatSummary): PanelActionPreviewField {
  return chat.isSandbox
    ? dataField('label-chat', maskedTitle(chat))
    : dataField('label-chat', `${maskedTitle(chat)} — ${chat.projectPath}`);
}

/** Строка карточки «Агент чата»: занят — сообщение ждёт конца хода. */
export function stateField(busy: boolean): PanelActionPreviewField {
  return textField('label-chat-state', busy ? 'value-chat-busy-queued' : 'value-chat-idle');
}

/** Проект чата для правил проекта: основная копия, у ребёнка разделения — её. */
export const chatProject = (chat: ChatSummary): string | undefined =>
  chat.isSandbox ? undefined : chat.homeProjectPath || chat.projectPath || undefined;

/** Провайдер чата — только Claude: чужой CLI живёт в другом разделе и маршруте. */
export async function assertClaudeChat(inject: InjectRoute, action: string): Promise<void> {
  const providers = await readRoute<ProvidersResponse>(inject, '/api/providers');
  if (providers.active !== 'claude') {
    throw new Error(
      `${action} supports only the Claude provider; the active one is «${providers.active}». ` +
        'Ask the human to write in that chat from the Chat page.',
    );
  }
}

/**
 * Модель и глубина следующего хода — как у поля ввода: назначенное чату при
 * разделении, иначе настройка панели. Оверрайд шапки живёт в браузере
 * человека, серверу его не видно, — карточка называет то, что уйдёт.
 */
export interface ChatSendPlan {
  model: string;
  effort: string;
}

export async function chatSendPlan(inject: InjectRoute, chat: ChatSummary): Promise<ChatSendPlan> {
  const settings = await readRoute<AppSettings>(inject, '/api/settings');
  return {
    model: chat.assignedModel || settings.chatModel || '',
    effort: chat.effort || settings.chatEffort || '',
  };
}

/**
 * Право правок хода, который начинает агент, — то, с каким шёл последний прогон
 * этого чата по тумблеру человека, а не выбор модели: агент не превращает чат
 * «только чтение» в чат с правками (ревью 28.09, M3). Неизвестно — без правок.
 */
export async function chatEdits(inject: InjectRoute, chat: ChatSummary): Promise<boolean> {
  const view = await readRoute<ChatAutoModeView>(
    inject,
    `/api/chat/${encode(chat.id)}/auto-mode?sessionId=${encode(chat.id)}`,
  );
  return view.allowEdits === true;
}

/** Тело продолжения разговора — то, что шлёт поле ввода открытого чата. */
export function continueBody(
  chat: ChatSummary,
  prompt: string,
  plan: ChatSendPlan,
  allowEdits: boolean,
): Record<string, unknown> {
  return {
    chatId: chat.id,
    // Продолжаем сессию чата, а не заводим новую — как поле ввода открытого чата.
    sessionId: chat.id,
    ...(!chat.isSandbox && chat.projectPath ? { projectPath: chat.projectPath } : {}),
    prompt,
    allowEdits,
    ...(plan.model ? { model: plan.model } : {}),
    ...(plan.effort ? { effort: plan.effort } : {}),
    // Занятый разговор не отказывает, а ставит сообщение за ходом — как поле
    // ввода, которое дописывает в очередь, пока агент работает.
    queueIfBusy: true,
  };
}

/** Строки модели и глубины карточки. */
export function planFields(plan: ChatSendPlan): PanelActionPreviewField[] {
  return [
    plan.model
      ? dataField('label-model', plan.model)
      : textField('label-model', 'value-model-default'),
    ...(plan.effort ? [dataField('label-effort', plan.effort)] : []),
  ];
}

/** Ответ маршрута отправки: поток до имени сессии или 202 «в очереди». */
type SendAnswer = StreamHead | { queued?: boolean; runId?: string } | undefined;

/** Кадр ошибки до имени сессии — CLI отказал, прогона нет. */
export function sendRefusal(body: unknown): string | undefined {
  const frames = (body as StreamHead | undefined)?.frames;
  const error = frames?.find((frame) => frame.kind === 'error');
  if (!error) return undefined;
  return typeof error.message === 'string' && error.message
    ? `The message was not delivered: ${error.message}`
    : 'The message was not delivered: the CLI refused.';
}

/** Итог отправки для модели: ушло сразу или ждёт конца хода. */
export function sendOutcome(chat: ChatSummary, body: unknown) {
  const answer = body as SendAnswer;
  if (answer && 'queued' in answer && answer.queued) {
    return {
      sent: true,
      queued: true,
      chatId: chat.id,
      note: 'The chat agent is busy; the message goes out when its current turn ends.',
    };
  }
  const head = answer as StreamHead | undefined;
  const session = head?.frames?.find((frame) => frame.kind === 'session');
  return {
    sent: true,
    chatId: chat.id,
    running: true,
    ...(head?.timedOut && !session
      ? { note: 'The CLI has not confirmed the turn yet; see list_active_runs.' }
      : {}),
    note2:
      'The chat works on its own now. Do not wait inside this turn: tell the human where the ' +
      'answer appears (this chat) and read_chat later when asked.',
  };
}

/** Дерево разговора и его план разделения — тем же маршрутом, что пульт чата. */
export const readTree = (inject: InjectRoute, chatId: string): Promise<ChatTreeView> =>
  readRoute<ChatTreeView>(inject, `/api/chat/${encode(chatId)}/tree`);

/** Ответ маршрута записи или исключение с его текстом. */
export async function writeRoute<T>(
  inject: InjectRoute,
  method: 'POST' | 'PUT',
  url: string,
  body: unknown,
): Promise<T> {
  const answer = await inject({ method, url, body });
  if (answer.status >= 400) throw routeError(url, answer.status, answer.body);
  return answer.body as T;
}

/** Путь, сравнимый с путём проекта в записи группы. */
export const samePath = (a: string, b: string): boolean =>
  resolve(a).toLowerCase() === resolve(b).toLowerCase();
