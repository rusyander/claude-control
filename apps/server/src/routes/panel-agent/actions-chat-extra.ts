import { z } from 'zod';
import type { AppSettings, Artifact, ChatMessagesPage, ChatSummary } from '@agentdeck/contracts';
import {
  HANDOFF_DEFAULT_CHECKPOINT,
  scanHandoffBlocks,
  type HandoffProposal,
} from '@agentdeck/contracts/chat-handoff';
import { KNOWN_EDITORS } from '../../domains/fs/EditorLauncher.ts';
import { maskSecretsInText } from '../../lib/secret-mask.ts';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
  type StreamHead,
} from './registry.ts';
import { card, encode, readRoute, routeError, textWindow } from './action-kit.ts';
import { chatEdits, maskedTitle } from './actions-chat-kit.ts';
import { findProject } from './actions-projects.ts';
import { dataField, textField } from './texts.ts';

/**
 * Чат сверх первого набора (P3): продолжение в чистой сессии — по блоку агента
 * и кнопкой «Перезапустить сессию», файлы чата в панели (прочитать, удалить) и
 * «Открыть в редакторе» у проекта. Всё — маршрутами, которые зовёт окно чата;
 * здесь только поиск чата по id, честная карточка и проекция ответа.
 *
 * Выгрузки разговора файлом здесь нет намеренно: это скачивание в браузере
 * человека (решение владельца D2 для выгрузок), а прочитать сам разговор агент
 * может чтением чата. Агент открывает чат и просит нажать «Выгрузить».
 */

const chatRef = z.string().trim().min(1).max(200).describe('Chat id from list_chats');

/** Чат из списка — тот же, что видит человек в разделе «Чат». */
async function findChat(inject: InjectRoute, ref: string): Promise<ChatSummary> {
  const chats = await readRoute<ChatSummary[]>(inject, '/api/chats');
  const wanted = ref.trim();
  const chat = chats.find((item) => item.id === wanted);
  if (!chat) throw new Error(`Chat «${wanted}» not found. Take the id from list_chats.`);
  return chat;
}

/** Идёт ли сейчас ход этого разговора — по реестру прогонов, как у шапки чата. */
async function isRunning(inject: InjectRoute, id: string): Promise<boolean> {
  const runs = await readRoute<Array<{ chatId: string; sessionId?: string; status: string }>>(
    inject,
    '/api/chat/active',
  );
  return runs.some(
    (run) => run.status === 'running' && (run.chatId === id || run.sessionId === id),
  );
}

const RUNNING_REFUSAL =
  'A run is going in this chat right now. Wait for the turn to end (or ask the human to stop it), then try again.';

/** Модель продолжения — как у шапки чата: выбор агента, назначенная чату, последняя. */
const runModel = (chat: ChatSummary, asked: string | undefined): string | undefined =>
  asked?.trim() || chat.assignedModel || chat.model || undefined;

const sessionInput = {
  chat: chatRef,
  model: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('Model for the new session; default = the model this chat runs on'),
};

/** Поля карточки продолжения — общие у блока агента и у перезапуска. */
function sessionFields(chat: ChatSummary, model: string | undefined, allowEdits: boolean) {
  return [
    dataField('label-project', chat.projectPath),
    model ? dataField('label-model', model) : textField('label-model', 'value-model-default'),
    textField('label-file-edits', allowEdits ? 'value-edits-allowed' : 'value-edits-denied'),
  ];
}

/**
 * Последнее предложение продолжения в ПОСЛЕДНЕМ ходе агента. Блок из хода, после
 * которого человек уже писал, — прошлое: карточка в чате у него тоже погасла.
 */
async function lastProposal(
  inject: InjectRoute,
  chatId: string,
): Promise<HandoffProposal | undefined> {
  const page = await readRoute<ChatMessagesPage>(
    inject,
    `/api/chats/${encode(chatId)}/messages?limit=60`,
  );
  const texts = (message: ChatMessagesPage['messages'][number]): string =>
    message.blocks
      .map((block) => (block.type === 'text' ? (block as { text: string }).text : ''))
      .join('\n');
  const lastHuman = page.messages.findLastIndex(
    (message) => message.role === 'user' && texts(message).trim() !== '',
  );
  const turn = page.messages.slice(lastHuman + 1).filter((message) => message.role === 'assistant');
  return scanHandoffBlocks(turn.map(texts).join('\n')).proposals.at(-1);
}

async function handoffTarget(inject: InjectRoute, ref: string) {
  const chat = await findChat(inject, ref);
  const proposal = await lastProposal(inject, chat.id);
  if (!proposal) {
    throw new Error(
      'The last answer of this chat carries no continuation proposal. To start a clean session ' +
        'anyway use restart_chat_session.',
    );
  }
  return { chat, proposal };
}

/** Ключ нового разговора из ответа продолжения — для страницы после действия. */
const newChatOf = (result: unknown): string | undefined => {
  const id = (result as { chatId?: unknown } | undefined)?.chatId;
  return typeof id === 'string' && id ? id : undefined;
};

const continueChatHandoff = definePanelAction({
  name: 'continue_chat_handoff',
  section: 'chat',
  risk: 'danger',
  title: 'journal-continue-chat-handoff',
  description:
    'Accept the continuation the chat agent proposed in its last answer («continue in a new ' +
    'session» card): the panel opens a clean session in the same folder with exactly that ' +
    'proposal and starts the run. Launches a CLI run. Needs confirmation.',
  input: z.object(sessionInput),
  route: async (input, inject) => {
    const { chat, proposal } = await handoffTarget(inject, input.chat);
    if (await isRunning(inject, chat.id)) throw new Error(RUNNING_REFUSAL);
    const model = runModel(chat, input.model);
    return {
      method: 'POST',
      url: '/api/chat/handoff',
      body: {
        projectPath: chat.projectPath,
        chatId: chat.id,
        sessionId: chat.id,
        proposal,
        startRun: true,
        allowEdits: await chatEdits(inject, chat),
        ...(model ? { model } : {}),
        ...(chat.effort ? { effort: chat.effort } : {}),
      },
    };
  },
  // Отпечаток — само предложение и состояние разговора: новый ход агента после
  // карточки принёс бы другое задание, а человек одобрял прежнее.
  fingerprint: async (input, inject) => {
    const { chat, proposal } = await handoffTarget(inject, input.chat);
    return fingerprintOf({
      proposal,
      updatedAt: chat.updatedAt,
      messages: chat.messageCount,
      running: await isRunning(inject, chat.id),
      edits: await chatEdits(inject, chat),
    });
  },
  preview: async (input, inject) => {
    const { chat, proposal } = await handoffTarget(inject, input.chat);
    if (await isRunning(inject, chat.id)) throw new Error(RUNNING_REFUSAL);
    return {
      ...card('summary-continue-chat-handoff', { title: maskedTitle(chat) }),
      fields: [
        dataField('label-handoff-done', maskSecretsInText(proposal.done)),
        dataField('label-handoff-next', maskSecretsInText(proposal.next)),
        dataField('label-handoff-checkpoint', proposal.checkpoint),
        ...sessionFields(chat, runModel(chat, input.model), await chatEdits(inject, chat)),
      ],
    };
  },
  shape: (_input, body) => {
    const started = body as { chatId?: string; started?: boolean; chainDepth?: number };
    return {
      chatId: started.chatId,
      started: started.started !== false,
      chainDepth: started.chainDepth,
    };
  },
  page: (_input, result) => {
    const id = newChatOf(result);
    return { route: '/chat', ...(id ? { focus: id } : {}) };
  },
});

/** Что вернул перезапуск: заведено сразу или чату ушла просьба обновить опору. */
type RestartOutcome =
  | { mode: 'started'; chatId: string; started: boolean; chainDepth: number }
  | { mode: 'requested'; prompt: string };

/**
 * Карта «вход вызова → чат»: `afterRoute` второго шага должен слать просьбу в
 * тот же разговор, что нашёл `route`, а не искать его заново по списку.
 */
const restartChats = new WeakMap<object, ChatSummary>();

const restartChatSession = definePanelAction({
  name: 'restart_chat_session',
  section: 'chat',
  risk: 'danger',
  title: 'journal-restart-chat-session',
  description:
    '«Restart session» of a chat: continue the same work in a clean session. If the chat’s ' +
    'checkpoint file is fresher than the human’s last message the new session starts at once; ' +
    'otherwise the chat first gets the standard request to update it, and the panel continues ' +
    'automatically when that turn ends. Launches a CLI run. Not while a run is going. Needs confirmation.',
  input: z.object(sessionInput),
  route: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    if (await isRunning(inject, chat.id)) throw new Error(RUNNING_REFUSAL);
    restartChats.set(input, chat);
    const model = runModel(chat, input.model);
    return {
      method: 'POST',
      url: `/api/chat/${encode(chat.id)}/restart`,
      body: {
        projectPath: chat.projectPath,
        sessionId: chat.id,
        allowEdits: await chatEdits(inject, chat),
        ...(model ? { model } : {}),
        ...(chat.effort ? { effort: chat.effort } : {}),
      },
    };
  },
  // Просьбу обновить опору вкладка шлёт сама обычным сообщением; у агента вкладки
  // нет — шлёт действие, тем же маршрутом отправки и с теми же моделью и правами.
  // Не ушла — автопродолжение снимается: иначе оно сработало бы на чужом ходе.
  afterRoute: async (input, body, inject) => {
    const outcome = body as RestartOutcome;
    if (outcome.mode !== 'requested') return outcome;
    const chat = restartChats.get(input) ?? (await findChat(inject, input.chat));
    const model = runModel(chat, input.model);
    const sent = await inject({
      method: 'POST',
      url: '/api/chat/send',
      stream: true,
      body: {
        chatId: chat.id,
        sessionId: chat.id,
        prompt: outcome.prompt,
        projectPath: chat.projectPath,
        allowEdits: await chatEdits(inject, chat),
        ...(model ? { model } : {}),
        ...(chat.effort ? { effort: chat.effort } : {}),
      },
    });
    const error = (sent.body as StreamHead | undefined)?.frames?.find(
      (frame) => frame.kind === 'error',
    );
    if (sent.status >= 400 || error) {
      await inject({
        method: 'POST',
        url: '/api/chat/handoff/auto',
        body: { chatId: chat.id, sessionId: chat.id, enabled: false },
      });
      const reason =
        sent.status >= 400
          ? routeError('/api/chat/send', sent.status, sent.body).message
          : String(error?.message ?? 'the CLI refused');
      throw new Error(
        `The chat was not restarted: the request to update its checkpoint could not be sent (${reason}). Nothing else changed.`,
      );
    }
    return { mode: 'requested', chatId: chat.id };
  },
  fingerprint: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    return fingerprintOf({
      id: chat.id,
      updatedAt: chat.updatedAt,
      messages: chat.messageCount,
      running: await isRunning(inject, chat.id),
      edits: await chatEdits(inject, chat),
    });
  },
  preview: async (input, inject) => {
    const chat = await findChat(inject, input.chat);
    if (await isRunning(inject, chat.id)) throw new Error(RUNNING_REFUSAL);
    return {
      ...card('summary-restart-chat-session', { title: maskedTitle(chat) }),
      fields: [
        ...sessionFields(chat, runModel(chat, input.model), await chatEdits(inject, chat)),
        textField('label-what-happens', 'value-restart-how', {
          checkpoint: HANDOFF_DEFAULT_CHECKPOINT,
        }),
      ],
    };
  },
  shape: (_input, body) => {
    const outcome = body as { mode: string; chatId?: string; chainDepth?: number };
    return outcome.mode === 'requested'
      ? {
          mode: 'requested',
          chatId: outcome.chatId,
          note:
            'The chat was asked to update its checkpoint file; when that turn ends the panel ' +
            'continues in a clean session by itself.',
        }
      : { mode: 'started', chatId: outcome.chatId, chainDepth: outcome.chainDepth };
  },
  page: (_input, result) => {
    const id = newChatOf(result);
    return { route: '/chat', ...(id ? { focus: id } : {}) };
  },
});

/** Файлы чата есть только у чатов в самой панели — маршрут отдаёт пустой список прочим. */
async function artifactsOf(inject: InjectRoute, chatId: string): Promise<Artifact[]> {
  return readRoute<Artifact[]>(inject, `/api/chat/${encode(chatId)}/artifacts`);
}

const BINARY_NAME = /\.(png|jpe?g|gif|webp|pdf)$/i;

const listChatArtifacts = definePanelAction({
  name: 'list_chat_artifacts',
  section: 'chat',
  risk: 'read',
  description:
    'Files a chat created in its own panel folder (chats without a project, inPanel in ' +
    'list_chats): name, kind, size, modified. A chat inside a real project has none here — its ' +
    'files are the project’s.',
  input: z.object({ chat: chatRef }),
  route: (input) => ({ method: 'GET', url: `/api/chat/${encode(input.chat)}/artifacts` }),
  // Путь папки — внутренность панели: человеку это «файлы чата», не каталог.
  shape: (_input, body) => ({
    files: (Array.isArray(body) ? (body as Artifact[]) : []).map(
      ({ name, kind, sizeBytes, modifiedAt }) => ({ name, kind, sizeBytes, modifiedAt }),
    ),
  }),
  summary: 'journal-list-chat-artifacts',
});

const readChatArtifact = definePanelAction({
  name: 'read_chat_artifact',
  section: 'chat',
  risk: 'read',
  description:
    'Text of one file from list_chat_artifacts (secrets masked), read in windows: pass nextOffset ' +
    'as offset for the rest. Images and PDF are not readable here — the human sees them in the ' +
    'chat’s file panel.',
  input: z.object({
    chat: chatRef,
    name: z.string().trim().min(1).max(300).describe('File name from list_chat_artifacts'),
    offset: z.number().int().min(0).optional().describe('Character offset; default 0'),
  }),
  route: (input) => {
    if (BINARY_NAME.test(input.name)) {
      throw new Error(
        `«${input.name}» is an image or PDF: it cannot be read as text. Open the chat (open_page /chat focus ${input.chat}) — the human sees it in the chat’s file panel.`,
      );
    }
    return {
      method: 'GET',
      url: `/api/chat/${encode(input.chat)}/artifact?name=${encode(input.name)}`,
    };
  },
  shape: (input, body) => {
    const content = (body as { content?: unknown } | undefined)?.content;
    const text = typeof content === 'string' ? content : '';
    if (text === '') {
      return {
        name: input.name,
        empty: true,
        note: 'The file is empty or too large to read inline (over 2 MB).',
      };
    }
    return { name: input.name, ...textWindow(maskSecretsInText(text), input.offset ?? 0) };
  },
  summary: 'journal-read-chat-artifact',
});

async function artifactTarget(inject: InjectRoute, chatRefValue: string, name: string) {
  const chat = await findChat(inject, chatRefValue);
  const file = (await artifactsOf(inject, chat.id)).find((item) => item.name === name);
  if (!file) {
    throw new Error(
      `File «${name}» is not among the files of chat «${maskedTitle(chat)}». Call list_chat_artifacts.`,
    );
  }
  return { chat, file };
}

const deleteChatArtifact = definePanelAction({
  name: 'delete_chat_artifact',
  section: 'chat',
  risk: 'danger',
  title: 'journal-delete-chat-artifact',
  description:
    'Delete one file from a chat’s own panel folder (list_chat_artifacts). Irreversible; files of ' +
    'chats inside a real project are never touched. Needs confirmation.',
  input: z.object({
    chat: chatRef,
    name: z.string().trim().min(1).max(300).describe('File name from list_chat_artifacts'),
  }),
  route: (input) => ({
    method: 'DELETE',
    url: `/api/chat/${encode(input.chat)}/artifact?name=${encode(input.name)}`,
  }),
  fingerprint: async (input, inject) => {
    const { file } = await artifactTarget(inject, input.chat, input.name);
    return fingerprintOf({ name: file.name, size: file.sizeBytes, modifiedAt: file.modifiedAt });
  },
  preview: async (input, inject) => {
    const { chat, file } = await artifactTarget(inject, input.chat, input.name);
    return {
      ...card('summary-delete-chat-artifact', { name: file.name, title: maskedTitle(chat) }),
      fields: [
        dataField('label-file', file.name),
        dataField('label-artifact-size', `${file.sizeBytes} B · ${file.modifiedAt}`),
      ],
    };
  },
  shape: (input) => ({ deleted: input.name }),
  page: (input) => ({ route: '/chat', focus: input.chat }),
});

const EDITOR_IDS = KNOWN_EDITORS.map((editor) => editor.id) as [string, ...string[]];

interface EditorRow {
  id: string;
  name: string;
  command: string;
  available: boolean;
}

/**
 * Какой редактор откроется — тем же порядком, что у маршрута: названный, из
 * настроек, первый найденный. Модель выбирает только из известного списка:
 * произвольное имя команды из PATH запускало бы что угодно на каталоге проекта.
 */
async function chosenEditor(inject: InjectRoute, asked: string | undefined): Promise<EditorRow> {
  const editors = await readRoute<EditorRow[]>(inject, '/api/editors');
  const settings = await readRoute<AppSettings>(inject, '/api/settings');
  const byCommand = (command: string | undefined) =>
    command ? editors.find((item) => item.command === command && item.available) : undefined;
  const asEntry = asked ? KNOWN_EDITORS.find((editor) => editor.id === asked) : undefined;
  if (asEntry && !byCommand(asEntry.command)) {
    throw new Error(`${asEntry.name} is not installed here (not in PATH). Call without editor.`);
  }
  const configured = settings.editor?.trim();
  const picked =
    byCommand(asEntry?.command) ??
    byCommand(configured) ??
    // Своя команда из настроек человека — её маршрут и запустит, если найдёт.
    (configured && !asEntry
      ? { id: configured, name: configured, command: configured, available: true }
      : undefined) ??
    editors.find((item) => item.available);
  if (!picked) {
    throw new Error(
      'No code editor found on this machine. Ask the human to set one in Settings or install VS Code / Cursor.',
    );
  }
  return picked;
}

const openInEditor = definePanelAction({
  name: 'open_project_in_editor',
  section: 'projects',
  risk: 'change',
  title: 'journal-open-in-editor',
  description:
    'Open a registered project folder in the human’s code editor (the «Open in editor» button). ' +
    'Changes no data; the editor window appears on the human’s screen. Needs confirmation.',
  input: z.object({
    project: z.string().trim().min(1).describe('Project id or absolute path from list_projects'),
    editor: z
      .enum(EDITOR_IDS)
      .optional()
      .describe('Editor id; default = the editor from Settings, else the first one installed'),
  }),
  route: async (input, inject) => {
    const project = await findProject(inject, input.project);
    const editor = await chosenEditor(inject, input.editor);
    return {
      method: 'POST',
      url: '/api/projects/open-in-editor',
      body: { path: project.path, editor: editor.command },
    };
  },
  fingerprint: async (input, inject) =>
    fingerprintOf({
      path: (await findProject(inject, input.project)).path,
      editor: (await chosenEditor(inject, input.editor)).command,
    }),
  preview: async (input, inject) => {
    const project = await findProject(inject, input.project);
    const editor = await chosenEditor(inject, input.editor);
    return {
      ...card('summary-open-in-editor', { name: project.name }),
      fields: [
        dataField('label-directory', project.path),
        dataField('label-editor', `${editor.name} (${editor.command})`),
      ],
    };
  },
  shape: (_input, body) => ({ opened: true, editor: (body as { editor?: string }).editor }),
});

/** Действия чата сверх первого набора — в порядке показа. */
export const CHAT_EXTRA_ACTIONS: readonly AnyPanelAction[] = [
  continueChatHandoff,
  restartChatSession,
  listChatArtifacts,
  readChatArtifact,
  deleteChatArtifact,
  openInEditor,
];
