import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  AppSettings,
  ChatSummary,
  MediaDeckPlan,
  MediaImagePlan,
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
} from '../registry.ts';
import { dataField, summaryText, textField } from '../texts/texts.ts';
import { readRoute, routeError } from '../action-kit/action-kit.ts';

/**
 * Действия раздела «Проекты, чат» (А4): чаты, идущие прогоны и новый чат с
 * первым сообщением. Всё исполняется маршрутами, которые зовёт окно чата;
 * здесь только проекция ответа для модели и честная карточка.
 */

/** Сколько чатов отдавать модели по умолчанию: список всей машины — сотни строк. */
const CHATS_DEFAULT_LIMIT = 20;

/** Проект реестра по id или абсолютному пути — тот, что увидит человек в списке. */
export async function findProject(inject: InjectRoute, ref: string): Promise<Project> {
  const projects = await readRoute<Project[]>(inject, '/api/projects');
  const wanted = ref.trim();
  const byPath = resolve(wanted).toLowerCase();
  const project = projects.find(
    (item) => item.id === wanted || resolve(item.path).toLowerCase() === byPath,
  );
  if (!project) {
    // Не «зарегистрируй»: презентация и вопрос проекта не требуют, а подсказка
    // «create_project» здесь и толкала модель регистрировать папку ради чата.
    throw new Error(
      `Project «${wanted}» is not registered. A chat that needs no project files (a presentation, a picture, a question) is start_chat WITHOUT project. ` +
        'Otherwise pick a registered one from list_projects; create_project only when the human asked to add this folder.',
    );
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
    'Filter by project path — chats in its git copies count too (homeProjectPath). ' +
    'inPanel: the chat lives in the panel itself — say it is a chat in the panel itself, never its folder path. ' +
    'Default limit 20.',
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
      // Разговор в git-копии числится и за основной копией — как во вкладке
      // проекта; иначе «чаты проекта» теряли всё, что «первая правка» увела в копию.
      .filter(
        (chat) =>
          !wanted ||
          [chat.projectPath, chat.homeProjectPath].some(
            (path) => path !== undefined && path !== '' && resolve(path).toLowerCase() === wanted,
          ),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const limit = input.limit ?? CHATS_DEFAULT_LIMIT;
    return {
      total: chats.length,
      chats: chats.slice(0, limit).map((chat) => ({
        id: chat.id,
        title: chat.title,
        projectPath: chat.projectPath,
        ...(chat.homeProjectPath ? { homeProjectPath: chat.homeProjectPath } : {}),
        // Папка песочницы — внутренность панели; человеку это «чат в панели».
        ...(chat.isSandbox ? { inPanel: true } : {}),
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

/** Режим поля ввода чата — те же три, что в меню «Режим» композера. */
const CHAT_MODES = ['message', 'deck', 'image'] as const;
type ChatMode = (typeof CHAT_MODES)[number];

const startChatInput = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Project id or absolute path from list_projects. Omit for a chat without a project ' +
        '(the Chats home tab): presentations, pictures and questions need none',
    ),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe('First message; for mode deck/image — what to make, in the human’s words'),
  mode: z
    .enum(CHAT_MODES)
    .optional()
    .describe(
      'Composer mode: message (default); deck = presentation (the chat agent dictates it, ' +
        'the panel builds HTML/PPTX/PDF files); image = picture',
    ),
  model: z.string().trim().max(200).optional().describe('Model; default = chat model in settings'),
  allowEdits: z
    .boolean()
    .optional()
    .describe('Let the chat agent edit project files; default false (read-only)'),
});
type StartChatInput = z.infer<typeof startChatInput>;

/** Ответ маршрута записи или исключение с его текстом — как `readRoute`. */
async function postRoute<T>(inject: InjectRoute, url: string, body: unknown): Promise<T> {
  const answer = await inject({ method: 'POST', url, body });
  if (answer.status >= 400) throw routeError(url, answer.status, answer.body);
  return answer.body as T;
}

/**
 * Первое сообщение нового чата в выбранном режиме.
 *
 * Презентация и картинка идут ТОЙ ЖЕ дорогой, что режим композера в чате с
 * агентом (`useChatMedia`): дорогу решает план сервера с признаком агента, а
 * просьбу собирает `/api/media/prompt` из каталога промптов. Своя сборка здесь
 * разошлась бы с правилами после первой правки каталога, а текст слайдов в
 * ответе агента панели — не презентация: файлы собирает панель из блока ответа.
 *
 * Растровая дорога картинки (контур, эндпоинт) — платная работа, которую панель
 * делает сама, без агента разговора; её человек запускает из композера, и
 * действие честно говорит об этом, а не подменяет дорогу бесплатной.
 */
async function firstMessage(input: StartChatInput, inject: InjectRoute): Promise<string> {
  const mode: ChatMode = input.mode ?? 'message';
  if (mode === 'message') return input.prompt;
  const kind = mode === 'deck' ? 'deck' : 'picture';
  const plan = await readRoute<MediaDeckPlan | MediaImagePlan>(
    inject,
    `/api/media/${mode === 'deck' ? 'decks' : 'images'}/plan?agent=1`,
  );
  if (!plan.available) {
    throw new Error(`Mode ${mode} is locked: ${plan.reason ?? 'unavailable'}.`);
  }
  if (plan.source !== 'agent') {
    throw new Error(
      `Mode ${mode} goes through «${plan.title}» (${plan.source}${plan.model ? `, ${plan.model}` : ''}), ` +
        'paid work the panel does itself. Ask the human to send it from the chat composer in that mode ' +
        '(open_page /chat).',
    );
  }
  const built = await postRoute<{ prompt: string }>(inject, '/api/media/prompt', {
    kind,
    topic: input.prompt,
  });
  return built.prompt;
}

/**
 * Временный ключ прогона по входу вызова. CLI с тяжёлой конфигурацией (хуки,
 * MCP) называет сессию дольше срока ожидания исполнителя, и без ключа страница
 * открывалась пустым «Новым чатом», хотя прогон уже шёл (живой прогон
 * 26.09.2026). Ключ заводит `route`, а `shape` и `page` получают тот же объект
 * входа — поэтому слабая карта, а не поле во входе, которое видит модель.
 */
const startedKeys = new WeakMap<object, string>();

const startChat = definePanelAction({
  name: 'start_chat',
  section: 'projects',
  risk: 'danger',
  title: 'journal-start-chat',
  description:
    'Start a NEW chat with a first message: launches a CLI agent run and opens the chat page in ' +
    'the same composer mode. "Open the chat about …" asks for an EXISTING chat: find it with ' +
    'list_chats and open_page /chat with focus = its id; start one only when none fits. ' +
    'Without project — a chat with no project, like the New chat button. ' +
    'A presentation or a picture = mode deck / image (never write slides or drawings yourself). ' +
    'Needs the human’s confirmation. Returns chatKey (the run key in list_active_runs) and the ' +
    'sessionId once the CLI names it.',
  input: startChatInput,
  // Тело — то, что шлёт окно чата при первом сообщении нового разговора:
  // временный ключ `new-…`, каталог проекта (без проекта — никакого, как у
  // «Нового чата» домашней вкладки), модель шапки (или настройки).
  route: async (input, inject) => {
    const project = input.project ? await findProject(inject, input.project) : undefined;
    const plan = await chatRunPlan(inject, input.model);
    const chatId = `new-${Date.now()}`;
    startedKeys.set(input, chatId);
    return {
      method: 'POST',
      url: '/api/chat/send',
      stream: true,
      body: {
        chatId,
        prompt: await firstMessage(input, inject),
        ...(project ? { projectPath: project.path } : {}),
        ...(plan.asked ? { model: plan.asked } : {}),
        allowEdits: input.allowEdits === true,
      },
    };
  },
  // Отпечаток — проект, план прогона (провайдер, модель из настроек, контур) и
  // первое сообщение: правило режима в каталоге поправили после карточки —
  // ушёл бы текст, которого человек не видел.
  fingerprint: async (input, inject) =>
    fingerprintOf({
      project: input.project ? await findProject(inject, input.project) : null,
      plan: await chatRunPlan(inject, input.model),
      message: await firstMessage(input, inject),
    }),
  preview: async (input, inject) => {
    const project = input.project ? await findProject(inject, input.project) : undefined;
    const plan = await chatRunPlan(inject, input.model);
    const mode: ChatMode = input.mode ?? 'message';
    // Промпт целиком (вход ограничен 20 000 символов): хвост, обрезанный ради
    // вида карточки, запустил бы агента с текстом, которого человек не читал.
    // У презентации и картинки это собранная просьба, а тема стоит отдельно.
    const message = await firstMessage(input, inject);
    return {
      ...(project
        ? summaryText('summary-start-chat', { project: project.name })
        : summaryText('summary-start-chat-home', {})),
      fields: [
        project
          ? dataField('label-project', `${project.name} — ${project.path}`)
          : textField('label-project', 'value-no-project'),
        textField('label-chat-mode', `value-mode-${mode}`),
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
        ...(mode === 'message' ? [] : [dataField('label-topic', input.prompt)]),
        dataField('label-first-message', message),
      ],
    };
  },
  // Кадр ошибки до имени сессии — CLI отказал, прогона нет. Это `failed` с его
  // причиной: «Done.» со `started: false` модель пересказывала как успех, а
  // человеку открывался пустой чат.
  refusal: (body) => {
    const error = (body as StreamHead | undefined)?.frames?.find((frame) => frame.kind === 'error');
    if (!error) return undefined;
    return typeof error.message === 'string' && error.message
      ? `The chat did not start: ${error.message}`
      : 'The chat did not start: the CLI refused.';
  },
  // Модели — начало прогона, а не весь поток: имя сессии и модель.
  shape: (input, body) => {
    const head = body as StreamHead;
    const session = head.frames.find((frame) => frame.kind === 'session');
    const chatKey = startedKeys.get(input);
    return {
      started: true,
      ...(chatKey ? { chatKey } : {}),
      ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
      ...(session?.model ? { model: session.model } : {}),
      ...(head.timedOut && !session
        ? { note: 'The CLI has not named the session yet; see list_active_runs.' }
        : {}),
    };
  },
  // Режим уезжает в адрес: страница чата открывается с тем же пунктом меню
  // «Режим», и правка колоды идёт следующим сообщением без лишнего щелчка.
  // Фокус — имя сессии, а пока его нет — ключ прогона: страница покажет живой
  // ход по любому из них (`runForUrl`).
  page: (input, result) => {
    const { sessionId, chatKey } = result as { sessionId?: unknown; chatKey?: unknown };
    const focus =
      typeof sessionId === 'string' ? sessionId : typeof chatKey === 'string' ? chatKey : undefined;
    const mode = input.mode && input.mode !== 'message' ? `?mode=${input.mode}` : '';
    return { route: `/chat${mode}`, ...(focus ? { focus } : {}) };
  },
});

/** Действия раздела «Проекты, чат» в порядке показа. */
export const PROJECT_CHAT_ACTIONS: readonly AnyPanelAction[] = [
  listChats,
  listActiveRuns,
  startChat,
];
