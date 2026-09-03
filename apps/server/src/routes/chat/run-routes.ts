import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { initiativePrompt } from '../../domains/chat/initiative.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { apiTokenPath } from '../../lib/api-token.ts';
import { shouldAutoApprove } from '../../domains/chat/auto-approve.ts';
import { createGuardedPatternsReader } from '../../domains/permissions.ts';
import { chatDirectory } from '../../domains/chat/ChatArtifacts.ts';
import { resolveWorkspace, permissionModeFor } from '../../domains/chat/ChatWorkspace.ts';
import {
  saveUpload,
  isSupportedUpload,
  buildPromptWithFiles,
  SUPPORTED_UPLOAD_EXTENSIONS,
} from '../../domains/chat/ChatUploads.ts';
import { activateGroupsForCwd } from '../../domains/group-activation.ts';
import { activeCliCommand } from '../../providers/cli.ts';
import { estimateCost } from '../../domains/analytics/pricing.ts';
import { projectsDir, validTargetCwd } from './paths.ts';
import { streamRun, streamGone } from '../../domains/chat/ChatStream.ts';

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
 * Прогон агента: отправка сообщения, поток ответа, остановка и права.
 *
 * Прогоны живут в реестре, отвязанном от HTTP-запроса: обрыв соединения или уход
 * на другую вкладку не убивают агента, а к идущему прогону можно переподключиться
 * потоком, догнав пропущенное. Остановка — только по явной кнопке.
 */
export function registerChatRunRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  registry: ChatRunRegistry,
  // Права и автоподтверждение — на сервер, не на модуль: два сервера в одном
  // процессе не должны делить висящие запросы и тумблеры. Сервер отдаёт свой
  // объект (его делит и продолжение в чистой сессии); тесты, поднимающие одни
  // эти маршруты, получают собственный.
  session: ChatSession,
): void {
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
   * Охраняемые паттерны: всё, что пользователь просил спрашивать или запрещать.
   * Спрашивается на каждый вызов инструмента, поэтому читатель кэширует ответ до
   * первой правки самих файлов настроек (см. `createGuardedPatternsReader`).
   */
  const guardedPatterns = createGuardedPatternsReader(() => ({
    settings: ctx.location.paths.settings,
    settingsLocal: ctx.location.paths.settingsLocal,
    store: ctx.store,
  }));

  // Адрес, по которому мини-MCP-сервер прав стучится за решением пользователя.
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

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
      projectsDir(ctx),
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

    // Набор, привязанный к этому проекту, включается сам — до запуска агента,
    // иначе правила и скиллы доехали бы только к следующему сообщению. Уже
    // включённая группа не трогается вовсе, поэтому вызов на каждом сообщении
    // ничего не стоит. Песочница исключена: у неё свой каталог конфигурации.
    // Осечка тут не имеет права ронять прогон — набор не главнее разговора.
    if (!workspace.isSandbox) {
      try {
        activateGroupsForCwd(
          { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
          cwd,
        );
      } catch (error) {
        app.log.warn({ err: error }, 'group activation failed');
      }
    }

    // Вложения кладём в папку панели и перечисляем пути в промпте: Claude Code
    // читает файлы с диска сам, включая PDF и картинки. Именно в папку панели,
    // а не в рабочую: у разговора из настоящего проекта cwd — это каталог
    // проекта, и вложение осело бы прямо в рабочем дереве, попав затем в
    // ближайший `git add`. Промпт получает абсолютные пути, поэтому читаются
    // они одинаково откуда угодно.
    // Неподдерживаемые сюда уже не доходят — их отсеял отказ выше.
    const uploadDir = workspace.isSandbox ? cwd : chatDirectory(chatId);
    const saved = (files ?? []).map((file) => saveUpload(uploadDir, file.name, file.base64));

    // Автоподтверждение — на этот прогон.
    session.armAutoApprove(chatId, {
      enabled: autoApproveRequested === true,
      // «Только чтение» — это выключенный тумблер правок в настоящем проекте;
      // в песочнице и при полном доступе правки разрешены всегда.
      allowEdits: workspace.isSandbox || allowEdits === true || fullAccess === true,
    });

    const initiative = initiativePrompt(ctx.store.getSettings(), {
      splitMuted: registry.isSplitMuted(chatId),
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
        // Инициативы панели (разделить задачи, закрыть этап чистой сессией) —
        // одной строкой к системному промпту. Тумблеры в настройках, потому что
        // уместны они не всякому: кто ведёт один короткий разговор, увидит в них
        // лишний шаг.
        ...(initiative ? { appendSystemPrompt: initiative } : {}),
        // Полный доступ снимает все проверки прав — по кнопке «Разрешить и
        // продолжить» у агента, вставшего из-за отсутствия разрешения.
        permissionMode: fullAccess ? 'bypassPermissions' : permissionModeFor(workspace, allowEdits),
        // Интерактивные права: запрос на инструмент вне авторазрешённого уходит
        // человеку кнопкой в чате. При полном доступе прав не спрашивают, но
        // брокер всё равно подключается — через него же приезжает ВОПРОС агента
        // с вариантами, и без брокера отвечать на него было бы нечем.
        permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
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

    await streamRun(registry, reply, chatId, 0);
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
        streamGone(reply);
        return;
      }

      await streamRun(registry, reply, chatId, fromSeq);
    },
  );

  /** Идущие прогоны — клиент подхватывает их после перезагрузки страницы. */
  app.get('/api/chat/active', () => registry.active());

  /** Накопленный за сеанс расход — счётчик в пульте переживает перезагрузку. */
  app.get('/api/chat/spend', () => registry.spend());

  app.post<{ Params: { chatId: string } }>('/api/chat/:chatId/stop', (request) => {
    // Заодно отклоняем висящие запросы прав — иначе агент ждал бы решения зря.
    session.abort(request.params.chatId);
    return { ok: registry.stop(request.params.chatId) };
  });

  /**
   * Тумблер автоподтверждения, щёлкнутый во время прогона. Без этого маршрута
   * новое положение действовало бы только со следующего сообщения, а человек
   * ждёт его сразу — он же щёлкает, потому что устал жать «Разрешить».
   */
  app.post<{ Params: { chatId: string }; Body: { enabled?: boolean } }>(
    '/api/chat/:chatId/auto-approve',
    (request) => {
      // Тело читаем через `?.`: запрос без него значит «выключено», а не 500 —
      // на пустом или обрезанном теле панель не должна выглядеть сломанной.
      session.toggleAutoApprove(request.params.chatId, request.body?.enabled === true);
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

    // Автоподтверждение: обратимый запрос разрешаем молча, не показывая
    // карточку. Человеку остаётся безвозвратное (удаление, затирание истории,
    // снос данных и инфраструктуры, публикация в чужой реестр) и всё, что
    // попадает под правила `ask`/`deny` пользователя, — граница целиком в
    // `domains/chat/auto-approve.ts`, там же и причина её выбора.
    const auto = session.autoApproveFor(runId);
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

    const decision = await session.requestPermission({ runId, toolName, input, toolUseId });
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
    const ok = session.decidePermission(
      chatId,
      toolUseId,
      behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: message ?? 'Отклонено пользователем.' },
    );
    return { ok };
  });
}
