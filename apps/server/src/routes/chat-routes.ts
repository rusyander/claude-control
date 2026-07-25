import { join, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import { readChats, readChatMessages } from '../domains/chat/ChatHistory.ts';
import { searchChats } from '../domains/chat/ChatSearch.ts';
import { listProjects } from '../domains/chat/ChatProjects.ts';
import { listRoots, listDirectory } from '../domains/fs/FileBrowser.ts';
import { detectEditors, resolveEditorCommand, openInEditor } from '../domains/fs/EditorLauncher.ts';
import { ChatRunRegistry, type RunSubscriber } from '../domains/chat/ChatRunRegistry.ts';
import { PermissionBroker } from '../domains/chat/ChatPermissions.ts';
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
} from '../domains/chat/ChatUploads.ts';
import { activeCliCommand } from '../providers/cli.ts';

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
 */
export function registerChatRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const registry = new ChatRunRegistry();
  const permissions = new PermissionBroker();

  // Адрес, по которому мини-MCP-сервер прав стучится за решением пользователя.
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

  const projectsDir = join(ctx.location.paths.root, 'projects');

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
            reply.raw.write(
              `data: ${JSON.stringify({ ...buffered.event, seq: buffered.seq })}\n\n`,
            );
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

  app.get('/api/chats', () => readChats(projectsDir));

  /**
   * Полнотекстовый поиск по телу переписки: в дополнение к фильтру списка по
   * заголовку/проекту/превью ищет по самим сообщениям и возвращает разговоры со
   * сниппетом вокруг совпадения. Читающий, без побочных эффектов; короткий
   * запрос отдаёт пустой результат, не читая диск.
   */
  app.get<{ Querystring: { q?: string } }>('/api/chat/search', (request) =>
    searchChats(projectsDir, request.query.q ?? ''),
  );

  /** Проекты, с которыми работал Claude Code, — для таба «Проекты» в чате. */
  app.get('/api/chats/projects', () => listProjects(projectsDir));

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
    (request) => {
      const limit = clampInt(request.query.limit, DEFAULT_MESSAGE_PAGE, 1, MAX_MESSAGE_PAGE);
      const offset = clampInt(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return readChatMessages(projectsDir, request.params.chatId, { limit, offset });
    },
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

      const page = await readChatMessages(projectsDir, chatId, { limit: Number.MAX_SAFE_INTEGER });
      if (page.messages.length === 0)
        return reply.code(404).send({ message: 'Разговор не найден' });

      const title = readChats(projectsDir).find((chat) => chat.id === chatId)?.title;
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
      projectPath,
      model,
      effort,
    } = request.body;

    // Разговор продолжается только из той папки, где он начинался. Для нового
    // чата, открытого из проекта, рабочей папкой становится каталог проекта.
    const workspace = resolveWorkspace(
      projectsDir,
      chatId,
      sessionId,
      true,
      validTargetCwd(projectPath),
    );

    if (workspace.isMissing) {
      reply.raw.writeHead(200, SSE_HEADERS);
      reply.raw.write(
        `data: ${JSON.stringify({
          kind: 'error',
          message: `Рабочая папка этого чата не найдена: ${workspace.cwd}. Разговор начинался в ней, и продолжить его можно только оттуда.`,
        })}\n\n`,
      );
      reply.raw.end();
      return;
    }

    const cwd = workspace.cwd;

    // Вложения кладём в папку панели и перечисляем пути в промпте: Claude Code
    // читает файлы с диска сам, включая PDF и картинки. Именно в папку панели,
    // а не в рабочую: у разговора из настоящего проекта cwd — это каталог
    // проекта, и вложение осело бы прямо в рабочем дереве, попав затем в
    // ближайший `git add`. Промпт получает абсолютные пути, поэтому читаются
    // они одинаково откуда угодно.
    const uploadDir = workspace.isSandbox ? cwd : chatDirectory(chatId);
    const saved = (files ?? [])
      .filter((file) => isSupportedUpload(file.name))
      .map((file) => saveUpload(uploadDir, file.name, file.base64));

    // Запускаем прогон в реестре (или подхватываем уже идущий) и подключаемся к
    // нему потоком. Обрыв этого соединения агента не тронет.
    registry.start(
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
    return { ok: registry.stop(request.params.chatId) };
  });

  /**
   * Запрос на разрешение от мини-MCP-сервера прав. Показываем его в потоке
   * разговора карточкой и держим ответ, пока человек не решит. Ответ уходит
   * обратно серверу прав, а он — агенту. Разговора нет (уже закрыт) → запрещаем.
   */
  app.post<{
    Body: { runId: string; toolName: string; input: unknown; toolUseId: string };
  }>('/api/chat/permission-request', async (request, reply) => {
    const { runId, toolName, input, toolUseId } = request.body;

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
    const workspace = resolveWorkspace(projectsDir, chatId, undefined, false);
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
