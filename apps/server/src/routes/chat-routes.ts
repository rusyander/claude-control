import { join, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import type { ChatMessage } from '@claude-control/contracts';
import { readChats, readChatMessages, findTranscript } from '../domains/chat/ChatHistory.ts';
import { readChatProgress } from '../domains/chat/ChatProgress.ts';
import { searchChats } from '../domains/chat/ChatSearch.ts';
import { listProjects } from '../domains/chat/ChatProjects.ts';
import { listRoots, listDirectory } from '../domains/fs/FileBrowser.ts';
import { detectEditors, resolveEditorCommand, openInEditor } from '../domains/fs/EditorLauncher.ts';
import {
  ChatRunRegistry,
  type RunSubscriber,
  type BufferedEvent,
} from '../domains/chat/ChatRunRegistry.ts';
import { PermissionBroker } from '../domains/chat/ChatPermissions.ts';
import { shouldAutoApprove } from '../domains/chat/auto-approve.ts';
import { readPermissions } from '../domains/permissions.ts';
import {
  readArtifacts,
  readArtifactText,
  readArtifactBinary,
  deleteArtifact,
  chatDirectory,
} from '../domains/chat/ChatArtifacts.ts';
import { buildChatExport, type ExportFormat } from '../domains/chat/ChatExport.ts';
import { resolveWorkspace, permissionModeFor } from '../domains/chat/ChatWorkspace.ts';
import {
  saveUpload,
  isSupportedUpload,
  buildPromptWithFiles,
  SUPPORTED_UPLOAD_EXTENSIONS,
} from '../domains/chat/ChatUploads.ts';
import { activeCliCommand } from '../providers/cli.ts';
import { estimateCost } from '../domains/analytics/pricing.ts';

/** Заголовки SSE-ответа: держим поток открытым, ничего не кэшируем. */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

/**
 * Маршруты чата. Ответ отдаётся потоком (SSE): пользователь видит текст по мере
 * генерации, как в самом Claude Code.
 *
 * Прогоны живут в реестре, отвязанном от HTTP-запроса: обрыв соединения или уход
 * на другую вкладку не убивают агента, а к идущему прогону можно переподключиться
 * потоком, догнав пропущенное. Остановка — только по явной кнопке.
 *
 * Реестр можно передать снаружи: в тестах это единственный способ поставить
 * маршруты в состояние «прогон уже идёт», не запуская настоящий CLI.
 */
export function registerChatRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  registry: ChatRunRegistry = new ChatRunRegistry(),
): void {
  const permissions = new PermissionBroker();

  // Реестр считает расход, но тарифов не знает: прайс и свои цены пользователя
  // доступны только здесь. Отдаём ему саму функцию, а не таблицу, — тогда правка
  // цен в настройках подхватывается со следующего же шага.
  registry.setCostEstimator((model, tokens) =>
    estimateCost(model, tokens, {
      overrides: ctx.store.getSettings().modelPricing,
      entries: ctx.pricing.current().entries,
    }),
  );

  /**
   * Автоподтверждение прав по разговорам: ключ тот же, под которым прогон
   * зарегистрирован у брокера прав (chatId из запроса на отправку). Состояние
   * живёт в памяти прогона: тумблер в шапке чата присылают и при отправке, и
   * отдельным запросом, когда его щёлкнули на ходу.
   */
  const autoApprove = new Map<string, { enabled: boolean; allowEdits: boolean }>();

  /** Охраняемые паттерны: всё, что пользователь просил спрашивать или запрещать. */
  const guardedPatterns = (): string[] =>
    readPermissions(ctx.location.paths.settings, ctx.store, ctx.location.paths.settingsLocal)
      .filter((rule) => rule.decision !== 'allow')
      .map((rule) => rule.pattern);

  // Адрес, по которому мини-MCP-сервер прав стучится за решением пользователя.
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

  /**
   * Папка разговоров Claude Code. Считается на каждом обращении, а не один раз
   * при регистрации маршрутов: каталог конфигурации меняется на лету
   * (`ctx.relocate` из настроек), и запомненный путь оставлял бы чат читать
   * ПРЕЖНИЙ каталог до перезапуска сервера — с пустым списком и без объяснений.
   */
  const projectsDir = (): string => join(ctx.location.paths.root, 'projects');

  /** Отказ на новое сообщение, пока прошлый ответ ещё генерируется. */
  const RUN_BUSY_MESSAGE =
    'Предыдущий ответ в этом разговоре ещё генерируется. Дождитесь его окончания или нажмите «Остановить» — сообщение не отправлено.';

  /**
   * Отказ до запуска агента: HTTP-статус плюс структурный `code`, а не
   * SSE-кадр с текстом.
   *
   * Раньше отказ приходил обычным `error`-событием потока, и клиент разбирал
   * его ТЕКСТ: и чтобы решить, показывать ли ошибку, и чтобы понять, временная
   * ли она. Текст же содержит пользовательский ввод — имя отклонённого файла.
   * Файл `network.zip` попадал под шаблон «временной» ошибки, и клиент молча
   * ретраил отправку дважды, прежде чем сказать хоть слово. Со статусом и кодом
   * решения принимаются по структуре: текст остаётся только для показа.
   */
  const refuse = (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ): FastifyReply => reply.code(status).send({ code, message, ...extra });

  /**
   * Отдать SSE-поток прогона в ответ, начиная с `fromSeq`. Держит соединение
   * живым пингом, догоняет буфер и живые события. Обрыв соединения только
   * отцепляет слушателя — прогон в реестре продолжается. Промис разрешается,
   * когда поток закрыт (прогон завершён или клиент отключился).
   */
  const streamRun = (reply: FastifyReply, chatId: string, fromSeq: number): Promise<void> =>
    new Promise((resolve) => {
      reply.raw.writeHead(200, SSE_HEADERS);

      // Пинг-комментарии не дают прокси/браузеру закрыть «молчащее» соединение,
      // пока агент долго работает в инструменте. Клиент их игнорирует.
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': ping\n\n');
        } catch {
          // Соединение уже закрыто — обработчик close всё уберёт.
        }
      }, 10_000);

      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        try {
          reply.raw.end();
        } catch {
          // уже закрыто
        }
        resolve();
      };

      const subscriber: RunSubscriber = {
        send: (buffered) => {
          try {
            reply.raw.write(frame(buffered));
          } catch {
            // Клиент отвалился — close-обработчик отцепит.
          }
        },
        close: finish,
      };

      const unsubscribe = registry.attach(chatId, fromSeq, subscriber);

      // Клиент закрыл соединение — отцепляем слушателя, но прогон НЕ трогаем.
      reply.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        resolve();
      });

      // Прогон уже завершён (буфер отдан) или его нет — закрываемся.
      if (!unsubscribe) finish();
    });

  app.get('/api/chats', () => readChats(projectsDir()));

  /**
   * Полнотекстовый поиск по телу переписки: в дополнение к фильтру списка по
   * заголовку/проекту/превью ищет по самим сообщениям и возвращает разговоры со
   * сниппетом вокруг совпадения. Читающий, без побочных эффектов; короткий
   * запрос отдаёт пустой результат, не читая диск.
   */
  app.get<{ Querystring: { q?: string } }>('/api/chat/search', (request) =>
    searchChats(projectsDir(), request.query.q ?? ''),
  );

  /** Проекты, с которыми работал Claude Code, — для таба «Проекты» в чате. */
  app.get('/api/chats/projects', () => listProjects(projectsDir()));

  /**
   * Каталог, в котором можно начать новый разговор проекта. Путь приходит от
   * клиента (пользователь выбрал проект из списка), поэтому подтверждаем, что
   * это существующий каталог: иначе Claude запустится не пойми где. Отсутствие
   * каталога не ошибка запроса — просто не переопределяем рабочую папку.
   */
  const validTargetCwd = (path: string | undefined): string | undefined => {
    if (!path || !isAbsolute(path)) return undefined;
    try {
      return statSync(path).isDirectory() ? path : undefined;
    } catch {
      return undefined;
    }
  };

  // --- Обзор файловой системы: выбор папки проекта ---

  app.get('/api/fs/roots', () => listRoots());

  app.get<{ Querystring: { path?: string; files?: string } }>('/api/fs/list', (request, reply) => {
    const path = request.query.path;
    if (!path || !isAbsolute(path))
      return reply.code(400).send({ message: 'Нужен абсолютный путь' });
    // `files=.zip,.json` — показать ещё и файлы с такими расширениями (выбор
    // архива переноса). Без параметра поведение прежнее: только каталоги.
    const fileExtensions = (request.query.files ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      return listDirectory(path, { fileExtensions });
    } catch {
      return reply.code(400).send({ message: 'Каталог недоступен' });
    }
  });

  // --- Открыть проект во внешнем редакторе ---

  /** Редакторы, установленные в системе, — для выбора в настройках. */
  app.get('/api/editors', () => detectEditors());

  app.post<{ Body: { path?: string; editor?: string } }>(
    '/api/projects/open-in-editor',
    (request, reply) => {
      const path = validTargetCwd(request.body.path);
      if (!path) return reply.code(400).send({ message: 'Каталог не найден' });

      // Явно заданный редактор → настроенный → первый найденный в системе.
      const command = resolveEditorCommand(request.body.editor || ctx.store.getSettings().editor);
      if (!command) {
        return reply.code(400).send({
          message: 'Редактор кода не найден. Укажите его в настройках или установите code/cursor.',
        });
      }

      openInEditor(path, command);
      return { ok: true, editor: command };
    },
  );

  /**
   * Лента переписки окном. По умолчанию — последние сообщения; более ранние
   * подгружаются увеличением `limit` («Загрузить ещё»). Читается порциями, без
   * загрузки всего транскрипта в ответ.
   */
  app.get<{ Params: { chatId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/chats/:chatId/messages',
    async (request) => {
      const limit = clampInt(request.query.limit, DEFAULT_MESSAGE_PAGE, 1, MAX_MESSAGE_PAGE);
      const offset = clampInt(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const page = await readChatMessages(projectsDir(), request.params.chatId, { limit, offset });
      return { ...page, messages: page.messages.map(withStepCost) };
    },
  );

  /**
   * Дополнить расход шага ценой по тарифу его модели.
   *
   * Считается здесь, а не в истории: тарифы живут в кэше прайса и в настройках
   * пользователя, до которых добирается только слой маршрутов. Цена нужна как
   * раз потому, что по объёму токенов дешёвый шаг от дорогого не отличить —
   * чтение кэша стоит на порядок меньше свежего входа.
   *
   * Момент берём по времени самого сообщения: у моделей бывают вводные цены с
   * датой окончания, и старая переписка должна считаться по тем тарифам,
   * которые действовали тогда.
   */
  function withStepCost(message: ChatMessage): ChatMessage {
    const { usage } = message;
    if (!usage?.model) return message;

    const at = Date.parse(message.timestamp);
    const costUsd = estimateCost(usage.model, usage, {
      overrides: ctx.store.getSettings().modelPricing,
      entries: ctx.pricing.current().entries,
      at: Number.isNaN(at) ? undefined : at,
    });

    return { ...message, usage: { ...usage, costUsd } };
  }

  /**
   * Отпечаток транскрипта: изменился ли разговор с прошлого раза.
   *
   * Страховка к потоку `/api/events`: тот же разговор могут вести из терминала
   * или расширения редактора, наблюдатель за файлами бывает выключен тумблером,
   * а поток — оборван прокси. Опрашивать этой точкой дёшево (одна `stat`), в
   * отличие от самой ленты: ту приходится читать построчно целиком, а
   * транскрипт бывает стомегабайтным.
   *
   * Нет файла — нули: разговор ещё не начат, и это не ошибка.
   */
  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId/version', (request) => {
    const path = findTranscript(projectsDir(), request.params.chatId);
    if (!path) return { mtimeMs: 0, size: 0 };

    try {
      const stats = statSync(path);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      // Файл убрали между поиском и чтением — для опроса это просто «пусто».
      return { mtimeMs: 0, size: 0 };
    }
  });

  /**
   * Прогресс агента: чекпоинты его собственного плана и дерево субагентов.
   * Только чтение — план принадлежит агенту, панель его не правит.
   */
  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/progress', (request) =>
    readChatProgress(projectsDir(), request.params.chatId),
  );

  /**
   * Выгрузка разговора файлом — Markdown или JSON. Собирается из всей переписки
   * (роли, время, текст); служебное и вложения-картинки в файл не тащим.
   */
  app.get<{ Params: { chatId: string }; Querystring: { format?: string } }>(
    '/api/chat/:chatId/export',
    async (request, reply) => {
      const { chatId } = request.params;
      const format: ExportFormat = request.query.format === 'json' ? 'json' : 'md';

      const page = await readChatMessages(projectsDir(), chatId, {
        limit: Number.MAX_SAFE_INTEGER,
      });
      if (page.messages.length === 0)
        return reply.code(404).send({ message: 'Разговор не найден' });

      const title = readChats(projectsDir()).find((chat) => chat.id === chatId)?.title;
      const file = buildChatExport(page.messages, format, title);
      const safeId = chatId.replace(/[^a-zA-Z0-9-]/g, '') || 'chat';

      return reply
        .header('Content-Disposition', `attachment; filename="chat-${safeId}.${file.ext}"`)
        .type(file.mime)
        .send(file.content);
    },
  );

  app.post<{
    Body: {
      chatId: string;
      prompt: string;
      sessionId?: string;
      name?: string;
      fork?: boolean;
      files?: { name: string; base64: string }[];
      /** Разрешить правку файлов в настоящем проекте — тумблером из шапки. */
      allowEdits?: boolean;
      /** Полный доступ (bypassPermissions) — «Разрешить и продолжить» у упавшего агента. */
      fullAccess?: boolean;
      /**
       * Автоподтверждение безопасных запросов прав — тумблером из шапки чата.
       * Опасное (git-записи, удаление, миграции) и всё под правилами `ask`/`deny`
       * по-прежнему спрашивают человека.
       */
      autoApprove?: boolean;
      /** Каталог проекта для нового разговора — когда чат открыт из списка проектов. */
      projectPath?: string;
      /** Модель для этого разговора (алиас или полное имя); пусто = по умолчанию. */
      model?: string;
      /** Глубина продумывания (--effort); пусто = по умолчанию. */
      effort?: string;
    };
  }>('/api/chat/send', { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    const {
      chatId,
      prompt,
      sessionId,
      name,
      fork,
      files,
      allowEdits,
      fullAccess,
      autoApprove: autoApproveRequested,
      projectPath,
      model,
      effort,
    } = request.body;

    // Прошлый ответ ещё генерируется — второй промпт принять некуда. Раньше
    // маршрут в этом случае молча подключался к идущему прогону с seq 0:
    // человек получал перепечатку прошлого ответа под своим новым сообщением, а
    // само сообщение не доходило ни до агента, ни до транскрипта. Отвечаем
    // отказом ДО сохранения вложений — иначе они осели бы на диске впустую.
    //
    // Отказ обязан быть действенным: в теле отдаём `runId` — ключ, под которым
    // прогон живёт в реестре. Вкладка, сдавшаяся после серии переподключений
    // (или просто вторая), по нему подключается к ЖИВОМУ прогону и получает
    // назад и текст ответа, и кнопку «Остановить». Без этого человек упирался в
    // отказ, которому нечего противопоставить, кроме перезагрузки страницы.
    if (registry.isRunning(chatId, sessionId)) {
      return refuse(reply, 409, 'run_busy', RUN_BUSY_MESSAGE, {
        runId: registry.resolveKey(chatId, sessionId),
      });
    }

    // Вложение, которое панель не умеет передавать, раньше просто исчезало:
    // чип в поле ввода был, файл до агента не доходил, и тот отвечал «файла не
    // вижу». Отказываем явно и перечисляем, что именно не принято. Имена
    // отклонённых файлов идут отдельным полем, а не только в тексте: клиент
    // собирает своё сообщение на своём языке, ничего не выковыривая из строки.
    const rejected = (files ?? []).filter((file) => !isSupportedUpload(file.name));
    if (rejected.length > 0) {
      const names = rejected.map((file) => file.name);
      return refuse(
        reply,
        415,
        'unsupported_upload',
        `Не поддерживаются вложения: ${names.join(', ')}. ` +
          `Сообщение не отправлено. Допустимые расширения: ${SUPPORTED_UPLOAD_EXTENSIONS.join(', ')}.`,
        { files: names, supported: SUPPORTED_UPLOAD_EXTENSIONS },
      );
    }

    // Разговор продолжается только из той папки, где он начинался. Для нового
    // чата, открытого из проекта, рабочей папкой становится каталог проекта.
    const workspace = resolveWorkspace(
      projectsDir(),
      chatId,
      sessionId,
      true,
      validTargetCwd(projectPath),
    );

    if (workspace.isMissing) {
      return refuse(
        reply,
        422,
        'workspace_missing',
        `Рабочая папка этого чата не найдена: ${workspace.cwd}. Разговор начинался в ней, и продолжить его можно только оттуда.`,
        { cwd: workspace.cwd },
      );
    }

    const cwd = workspace.cwd;

    // Вложения кладём в папку панели и перечисляем пути в промпте: Claude Code
    // читает файлы с диска сам, включая PDF и картинки. Именно в папку панели,
    // а не в рабочую: у разговора из настоящего проекта cwd — это каталог
    // проекта, и вложение осело бы прямо в рабочем дереве, попав затем в
    // ближайший `git add`. Промпт получает абсолютные пути, поэтому читаются
    // они одинаково откуда угодно.
    // Неподдерживаемые сюда уже не доходят — их отсеял отказ выше.
    const uploadDir = workspace.isSandbox ? cwd : chatDirectory(chatId);
    const saved = (files ?? []).map((file) => saveUpload(uploadDir, file.name, file.base64));

    // Автоподтверждение — на этот прогон. Заодно выбрасываем записи прогонов,
    // которые уже не идут: иначе карта копила бы по строчке на каждый разговор.
    for (const key of autoApprove.keys()) if (!registry.isRunning(key)) autoApprove.delete(key);
    autoApprove.set(chatId, {
      enabled: autoApproveRequested === true,
      // «Только чтение» — это выключенный тумблер правок в настоящем проекте;
      // в песочнице и при полном доступе правки разрешены всегда.
      allowEdits: workspace.isSandbox || allowEdits === true || fullAccess === true,
    });

    // Запускаем прогон в реестре и подключаемся к нему потоком. Обрыв этого
    // соединения агента не тронет.
    const started = registry.start(
      chatId,
      {
        prompt: buildPromptWithFiles(prompt, saved),
        sessionId,
        name,
        fork,
        cwd,
        // Команда запуска — из активного провайдера (Ф1: всегда Claude).
        command: activeCliCommand(ctx.store),
        // Модель и глубина продумывания — выбор пользователя в шапке чата.
        model,
        effort,
        // Полный доступ снимает все проверки прав — по кнопке «Разрешить и
        // продолжить» у агента, вставшего из-за отсутствия разрешения.
        permissionMode: fullAccess ? 'bypassPermissions' : permissionModeFor(workspace, allowEdits),
        // Интерактивные права: запрос на инструмент вне авторазрешённого уходит
        // человеку кнопкой в чате (при полном доступе ChatRun это пропустит).
        permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl },
      },
      // Каталог проекта — для группировки статусов и восстановления после F5;
      // у песочницы/домашнего чата проекта нет.
      { projectPath: workspace.isSandbox ? undefined : cwd, sessionId },
    );

    // Страховка на случай, если прогон успел появиться между проверкой выше и
    // запуском: подключаться к ЧУЖОМУ прогону с seq 0 нельзя — это и была
    // подмена ответа. Лучше честный отказ — с тем же ключом для подключения.
    if (!started) {
      return refuse(reply, 409, 'run_busy', RUN_BUSY_MESSAGE, {
        runId: registry.resolveKey(chatId, sessionId),
      });
    }

    await streamRun(reply, chatId, 0);
  });

  /**
   * Переподключение к идущему прогону: догнать пропущенное с `from` и слушать
   * дальше. Так клиент восстанавливает поток после обрыва связи и после
   * перезагрузки страницы. Если прогона нет — отвечаем маркером `gone`, чтобы
   * клиент прекратил переподключение, а не долбил впустую.
   */
  app.get<{ Params: { chatId: string }; Querystring: { from?: string } }>(
    '/api/chat/:chatId/stream',
    async (request, reply) => {
      const { chatId } = request.params;
      const fromSeq = Number(request.query.from) || 0;

      if (!registry.has(chatId)) {
        reply.raw.writeHead(200, SSE_HEADERS);
        reply.raw.write(`data: ${JSON.stringify({ kind: 'gone' })}\n\n`);
        reply.raw.end();
        return;
      }

      await streamRun(reply, chatId, fromSeq);
    },
  );

  /** Идущие прогоны — клиент подхватывает их после перезагрузки страницы. */
  app.get('/api/chat/active', () => registry.active());

  /** Накопленный за сеанс расход — счётчик в пульте переживает перезагрузку. */
  app.get('/api/chat/spend', () => registry.spend());

  app.post<{ Params: { chatId: string } }>('/api/chat/:chatId/stop', (request) => {
    // Заодно отклоняем висящие запросы прав — иначе агент ждал бы решения зря.
    permissions.cancelRun(request.params.chatId);
    autoApprove.delete(request.params.chatId);
    return { ok: registry.stop(request.params.chatId) };
  });

  /**
   * Тумблер автоподтверждения, щёлкнутый во время прогона. Без этого маршрута
   * новое положение действовало бы только со следующего сообщения, а человек
   * ждёт его сразу — он же щёлкает, потому что устал жать «Разрешить».
   * Права на правки берём из уже идущего прогона: их задаёт другой тумблер.
   */
  app.post<{ Params: { chatId: string }; Body: { enabled?: boolean } }>(
    '/api/chat/:chatId/auto-approve',
    (request) => {
      const { chatId } = request.params;
      const current = autoApprove.get(chatId);
      autoApprove.set(chatId, {
        enabled: request.body.enabled === true,
        allowEdits: current?.allowEdits ?? false,
      });
      return { ok: true };
    },
  );

  /**
   * Запрос на разрешение от мини-MCP-сервера прав. Показываем его в потоке
   * разговора карточкой и держим ответ, пока человек не решит. Ответ уходит
   * обратно серверу прав, а он — агенту. Разговора нет (уже закрыт) → запрещаем.
   */
  app.post<{
    Body: { runId: string; toolName: string; input: unknown; toolUseId: string };
  }>('/api/chat/permission-request', async (request, reply) => {
    const { runId, toolName, input, toolUseId } = request.body;

    // Автоподтверждение: безопасный запрос разрешаем молча, не показывая
    // карточку. Опасное (записи в git, удаление, миграции, записи через MCP) и
    // всё, что попадает под правила `ask`/`deny` пользователя, идёт человеку —
    // ради этого тумблер и существует.
    const auto = autoApprove.get(runId);
    if (
      auto?.enabled &&
      shouldAutoApprove({
        toolName,
        input,
        guardedPatterns: guardedPatterns(),
        allowEdits: auto.allowEdits,
      })
    ) {
      return reply.send({ behavior: 'allow', updatedInput: input });
    }

    const shown = registry.emitExternal(runId, { kind: 'permission', toolName, input, toolUseId });
    if (!shown) return reply.send({ behavior: 'deny', message: 'Разговор не найден.' });

    const decision = await permissions.request({ runId, toolName, input, toolUseId });
    // Помечаем в потоке, что решение принято — карточка в чате обновится.
    registry.emitExternal(runId, {
      kind: 'permissionResolved',
      toolUseId,
      behavior: decision.behavior,
    });
    return reply.send(decision);
  });

  /** Решение пользователя по запросу прав (клик «Разрешить»/«Запретить»). */
  app.post<{
    Params: { chatId: string };
    Body: { toolUseId: string; behavior: 'allow' | 'deny'; message?: string };
  }>('/api/chat/:chatId/permission-decision', (request) => {
    const { chatId } = request.params;
    const { toolUseId, behavior, message } = request.body;
    const ok = permissions.decide(
      chatId,
      toolUseId,
      behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: message ?? 'Отклонено пользователем.' },
    );
    return { ok };
  });

  /**
   * Артефакты показываем только у чатов песочницы. Разговор из настоящего
   * проекта работает в его каталоге, и вывалить весь репозиторий списком
   * «созданных файлов» было бы и бесполезно, и опасно.
   */
  const artifactDirectory = (chatId: string): string | undefined => {
    const workspace = resolveWorkspace(projectsDir(), chatId, undefined, false);
    return workspace.isSandbox && !workspace.isMissing ? workspace.cwd : undefined;
  };

  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/artifacts', (request) => {
    const dir = artifactDirectory(request.params.chatId);
    return dir ? readArtifacts(dir) : [];
  });

  app.get<{ Params: { chatId: string }; Querystring: { name: string; as?: string } }>(
    '/api/chat/:chatId/artifact',
    (request, reply) => {
      const dir = artifactDirectory(request.params.chatId);
      if (!dir) return reply.code(404).send({ message: 'Файл не найден' });

      const { name, as } = request.query;

      // Картинки и PDF отдаём как файл — их встраивает сам браузер.
      if (/\.(png|jpe?g|gif|webp|pdf)$/i.test(name)) {
        const binary = readArtifactBinary(dir, name);
        if (!binary) return reply.code(404).send({ message: 'Файл не найден' });

        return reply
          .type(name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/*')
          .send(binary);
      }

      // Предпросмотр страницы: содержимое должно прийти разметкой, иначе
      // во врезке покажется JSON вместо самой страницы.
      if (as === 'html') {
        return (
          reply
            .type('text/html; charset=utf-8')
            // Страницу пишет модель — во врезке она изолирована, но и на уровне
            // ответа запрещаем ей тянуть что-либо из сети.
            .header(
              'Content-Security-Policy',
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:",
            )
            .send(readArtifactText(dir, name))
        );
      }

      return { name, content: readArtifactText(dir, name) };
    },
  );

  /**
   * Удаление артефакта. Разрешаем только у чатов песочницы: их файлы —
   * результат работы в отдельной папке панели, и убрать лишнее там безопасно.
   * У разговора из настоящего проекта `artifactDirectory` вернёт `undefined` —
   * трогать рабочее дерево нельзя. Имя файла обезврежено на уровне домена
   * (`deleteArtifact` берёт только basename), выйти за папку чата им не удастся.
   */
  app.delete<{ Params: { chatId: string }; Querystring: { name?: string } }>(
    '/api/chat/:chatId/artifact',
    (request, reply) => {
      const dir = artifactDirectory(request.params.chatId);
      const name = request.query.name;
      if (!dir || !name) return reply.code(404).send({ message: 'Файл не найден' });

      return deleteArtifact(dir, name)
        ? { ok: true }
        : reply.code(404).send({ message: 'Файл не найден' });
    },
  );
}

/**
 * Похоже ли падение прогона на временное — «сеть моргнула», перегрузка, таймаут.
 *
 * Разбор текста живёт ЗДЕСЬ, а не на клиенте, и применяется только к ошибкам,
 * пришедшим от самого CLI. Клиент по тексту не решает ничего: он видит готовый
 * флаг. Отказы панели (занят/вложение/нет папки) сюда не попадают вовсе — они
 * уходят HTTP-статусом с кодом, и подставить в такой текст своё имя файла,
 * чтобы выпросить авто-ретрай, больше нельзя.
 */
export function isRetriableRunError(message: string): boolean {
  return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|Connection error|overloaded|temporarily|timed?\s?out|\b50[234]\b|\b529\b/i.test(
    message,
  );
}

/**
 * Кадр SSE. Ошибке прогона добавляем структурный `retriable` — по нему клиент
 * решает, перезапускать ли самому, не заглядывая в текст сообщения.
 */
function frame(buffered: BufferedEvent): string {
  const event = buffered.event;
  const payload =
    event.kind === 'error'
      ? { ...event, seq: buffered.seq, retriable: isRetriableRunError(event.message) }
      : { ...event, seq: buffered.seq };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Размер окна ленты по умолчанию — последние N сообщений разговора. */
const DEFAULT_MESSAGE_PAGE = 400;
/** Верхняя граница окна: больше за один запрос отдавать незачем. */
const MAX_MESSAGE_PAGE = 5000;

/** Целое из строки запроса с зажимом в границы; мусор → значение по умолчанию. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
