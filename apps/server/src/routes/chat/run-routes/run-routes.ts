import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../../context.ts';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import { initiativePrompt } from '../../../domains/chat/initiative/initiative.ts';
import { linkedChildAppend } from '../../../domains/chat/group-run-lines/group-run-lines.ts';
import { genTimeSink } from '../../../domains/chat/gen-time-ledger/gen-time-ledger.ts';
import type { ChatRunRegistry } from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { CORE_PERMIT_TOOL } from '../../../domains/chat/core-run/core-run.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { apiTokenPath, readApiToken } from '../../../lib/api-token/api-token.ts';
import { chatDeliveryFor } from '../../../domains/project-git/project-git.ts';
import { chatDirectory } from '../../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { findTranscript } from '../../../domains/chat/ChatTranscriptFile/ChatTranscriptFile.ts';
import {
  AUTONOMOUS_PERMISSION_MODE,
  resolveWorkspace,
  permissionModeFor,
} from '../../../domains/chat/ChatWorkspace/ChatWorkspace.ts';
import {
  saveUpload,
  isSupportedUpload,
  buildPromptWithFiles,
  SUPPORTED_UPLOAD_EXTENSIONS,
} from '../../../domains/chat/ChatUploads/ChatUploads.ts';
import {
  activateGroupsForCwd,
  groupsActivatedNotice,
} from '../../../domains/group-activation/group-activation.ts';
import {
  describeGaps,
  readinessForCwd,
  repairCopy,
} from '../../../domains/project-git/copy-readiness.ts';
import { expandAssignedModel } from '../../../domains/model-cascade/model-cascade.ts';
import { loweredWorkPrompt } from '@agentdeck/contracts/model-cascade';
import { providerCliCommand } from '../../../providers/cli/cli.ts';
import { getActiveProvider } from '../../../providers/registry.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { supportsCliAutoMode } from '../../../providers/auto-mode/auto-mode.ts';
import type { ChatAutoModeView } from '@agentdeck/contracts';
import { estimateStepCost } from '../../../domains/analytics/pricing.ts';
import { projectsDir, validTargetCwd } from '../paths.ts';
import { streamRun, streamGone } from '../../../domains/chat/ChatStream/ChatStream.ts';
import {
  QUEUED_SEND_HEADER,
  QueuedSendJournal,
  queueAfterRun,
  type QueuedSend,
} from '../../../domains/chat/busy-send-queue.ts';
import { SentOnce } from '../../../domains/chat/sent-once.ts';
import { parseBody } from '../../../lib/request-body.ts';
import {
  autoApproveBodySchema,
  chatSendBodySchema,
  permissionDecisionBodySchema,
} from '@agentdeck/contracts/request-bodies';
import { humanOnly } from '../human-only/human-only.ts';
import { humanOnlyDepsFor } from '../human-only/human-only-deps.ts';

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
  // `messageCode` — перевод текста на клиенте (`server-messages.ts`); русский
  // `message` остаётся запасным для клиентов, кода не знающих.
  extra?: Record<string, unknown> & {
    messageCode?: ServerMessageCode;
    params?: ServerMessageParams;
  },
): FastifyReply => reply.code(status).send({ code, message, ...extra });

/**
 * Ответ на запрос прав, который умер раньше ответа: CLI оборвал вызов по своему
 * сроку или истёк срок брокера (`ChatPermissions.ts`). 410 — запрос был, но его
 * больше нет; телефон и вкладка показывают текст по `messageCode`.
 */
/**
 * Отправка, когда активен чужой CLI. Этот маршрут — чат Claude: аргументы
 * собирает адаптер Claude в ядре под `claude` (`--output-format stream-json
 * --include-partial-messages --permission-prompt-tool …`), и раньше он брал
 * команду активного провайдера — телефон при активном Qwen запускал `qwen` с
 * флагами Claude. Тихо уйти в Claude тоже нельзя: человек выбрал другой CLI.
 * Поэтому честный отказ с кодом — телефон и вкладка показывают его своим языком.
 */
const refuseForeignProvider = (reply: FastifyReply, provider: ConfigProvider): FastifyReply =>
  refuse(
    reply,
    409,
    'provider_not_claude',
    `Активен ${provider.name}: этот маршрут запускает только чат Claude. Сообщение не отправлено — пишите в чат ${provider.name} на компьютере или переключите активный CLI на Claude.`,
    {
      provider: provider.id,
      messageCode: 'chat-send-foreign-provider',
      params: { provider: provider.name },
    },
  );

const refuseExpired = (reply: FastifyReply): FastifyReply =>
  refuse(
    reply,
    410,
    'permission_expired',
    'Запрос прав уже истёк: агент перестал ждать ответа, и решение ничего не запустит.',
    { messageCode: 'permission-expired' },
  );

/** Висящая карточка этого вызова — вопрос права задачи ядра (`CORE_PERMIT_TOOL`). */
export const isCorePermitCard = (
  pending: readonly { toolName: string; toolUseId: string }[],
  toolUseId: string,
): boolean => pending.some((p) => p.toolUseId === toolUseId && p.toolName === CORE_PERMIT_TOOL);

const refuseCorePermit = (reply: FastifyReply): FastifyReply =>
  refuse(
    reply,
    409,
    'core_permit_browser_only',
    'Вопрос права задачи ядра отвечается из окна чата: ответ уходит ядру командой браузера, этот маршрут его ядру не передаёт.',
    { messageCode: 'core-permit-browser-only' },
  );

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
  /**
   * Разговор принадлежит группе на паузе (`pausedGroupOf`). Досылку без человека
   * (`automatic`) такой разговор не принимает: паузу снимает только человек.
   */
  heldOf?: (chatId: string) => boolean,
): void {
  // Маршруты решений человека отвечают только человеку: процесс модели —
  // потомок любого прогона или CLI панели — получает 403 (`human-only.ts`).
  const humanDeps = humanOnlyDepsFor(registry);
  const sentOnce = new SentOnce();
  // Реестр считает расход, но тарифов не знает: прайс и свои цены пользователя
  // доступны только здесь. Отдаём ему саму функцию, а не таблицу, — тогда правка
  // цен в настройках подхватывается со следующего же шага.
  registry.setCostEstimator((model, tokens) =>
    estimateStepCost(model, tokens, {
      overrides: ctx.store.getSettings().modelPricing,
      entries: ctx.pricing.current().entries,
    }),
  );
  // Скорость ответа переживает конец хода: лента из транскрипта берёт время отсюда.
  registry.setGenTimeSink(genTimeSink(ctx.location.paths.appData));

  // Адрес панели для карточек прав задачи ядра (`core-run.ts watchPermits` берёт `runId`).
  const selfBaseUrl = `http://127.0.0.1:${process.env.PORT ?? 5178}`;

  // Очередь сообщений занятому разговору — на диске: перезапуск панели не
  // должен молча терять ответ, о котором вкладка уже сказала «в очереди» (m7).
  const queuedSends = new QueuedSendJournal(ctx.location.paths.appData);
  /** Отправить сообщение из очереди тем же маршрутом — со всеми его проверками. */
  const sendQueued = (entry: QueuedSend, authorization?: string): void => {
    queuedSends.remove(entry.id);
    // После перезапуска заголовка человека нет — нужен свой токен, если он включён.
    const auth =
      authorization ??
      (ctx.store.getSettings().remoteAccess.enabled ? `Bearer ${readApiToken()}` : undefined);
    app
      .inject({
        method: 'POST',
        url: '/api/chat/send',
        headers: { ...(auth ? { authorization: auth } : {}), [QUEUED_SEND_HEADER]: '1' },
        payload: entry.body as Record<string, unknown>,
      })
      .then((sent) => {
        if (sent.statusCode >= 300) {
          app.log.warn({ chatId: entry.chatId, status: sent.statusCode }, 'queued send refused');
        }
      })
      .catch((error: unknown) =>
        app.log.warn({ err: error, chatId: entry.chatId }, 'queued send failed'),
      );
  };
  const sendAfterRun = (entry: QueuedSend, runId: string, authorization?: string): void =>
    queueAfterRun(
      registry,
      runId,
      () => sendQueued(entry, authorization),
      undefined,
      () => {
        queuedSends.remove(entry.id);
        app.log.warn({ chatId: entry.chatId }, 'queued send dropped: run stopped');
      },
    );
  // Оставшееся от прежнего процесса — после готовности сервера: усыновление
  // прогонов из журнала к этому моменту уже прошло (`createRuntime`), и занятый
  // разговор отличается от свободного честно.
  app.addHook('onReady', async () => {
    const pending = queuedSends.all();
    if (pending.length === 0) return;
    setTimeout(() => {
      for (const entry of pending) {
        const raw = (entry.body as { sessionId?: unknown } | null)?.sessionId;
        const sessionId = typeof raw === 'string' ? raw : undefined;
        if (registry.isRunning(entry.chatId, sessionId)) {
          sendAfterRun(entry, registry.resolveKey(entry.chatId, sessionId));
        } else {
          sendQueued(entry);
        }
      }
    }, 0);
  });

  // Форма тела — схема в contracts (`chatSendBodySchema`), там же и смысл полей.
  app.post<{ Body: unknown }>(
    '/api/chat/send',
    { bodyLimit: 64 * 1024 * 1024 },
    async (request, reply) => {
      const body = parseBody(chatSendBodySchema, request.body, reply);
      if (!body) return reply;
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
        parentChatId,
        parentTitle,
        model,
        effort,
        lowered,
      } = body;
      // Провайдер — один снимок на весь запрос: и отказ, и команда запуска ниже
      // читают его, а не настройку заново (переключение посреди запроса не
      // должно дать бинарь одного CLI с аргументами другого).
      const provider = getActiveProvider(ctx.store);
      const queuedByServer = Boolean(request.headers[QUEUED_SEND_HEADER]);

      // Это сообщение агент уже получил, а клиент ответа не узнал и досылает его
      // (см. `SentOnce`). Очередь сервера несёт метку принятого ею же сообщения —
      // её доставка не повтор.
      if (body.clientId && !queuedByServer && sentOnce.has(body.clientId)) {
        const running = registry.isRunning(chatId, sessionId);
        return reply.code(202).send({
          steered: true,
          duplicate: true,
          ...(running ? { runId: registry.resolveKey(chatId, sessionId) } : {}),
        });
      }
      const delivered = (): void => {
        if (body.clientId) sentOnce.remember(body.clientId);
      };

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
        const runId = registry.resolveKey(chatId, sessionId);
        // Сообщение посреди хода — агенту сразу (живая сессия Claude): он увидит
        // его на ближайшем шаге и учтёт, не дожидаясь конца всей работы.
        // Вложения так не едут — они идут своим ходом, через очередь.
        if (body.steer && (files ?? []).length === 0 && registry.steer(chatId, sessionId, prompt)) {
          delivered();
          return reply.code(202).send({ steered: true, runId });
        }
        // Слово идущему ходу выше — не новый запуск, его чужой CLI не касается.
        // Очередь же потом запустит прогон — её при чужом CLI не принимаем.
        if (provider.id !== 'claude') return refuseForeignProvider(reply, provider);
        // Просили не отказывать (ответ из хаба ребёнку, чей прогон вкладка не
        // знает): сообщение ждёт конца хода на сервере и уходит тем же маршрутом
        // — со всеми его проверками, — а не теряется в 409.
        if (body.queueIfBusy) {
          const entry: QueuedSend = {
            id: randomUUID(),
            chatId,
            body,
            queuedAt: new Date().toISOString(),
          };
          queuedSends.add(entry);
          sendAfterRun(entry, runId, request.headers.authorization);
          delivered();
          return reply.code(202).send({ queued: true, runId });
        }
        return refuse(reply, 409, 'run_busy', RUN_BUSY_MESSAGE, {
          runId,
          messageCode: 'run-busy',
        });
      }

      if (provider.id !== 'claude') return refuseForeignProvider(reply, provider);

      // Досылка без человека — очередь вкладки по концу хода, автоповтор — группу
      // на паузе не будит: через 3 с после «Паузы» из хаба вкладка дослала ответ
      // из своей очереди, и группа пошла дальше (карточка 33 прогона 20.10).
      // Паузу снимает «Продолжить» или сообщение, которое человек пишет сейчас.
      if (body.automatic && (heldOf?.(chatId) || (sessionId ? heldOf?.(sessionId) : false))) {
        return refuse(
          reply,
          409,
          'group_paused',
          'Группа на паузе — сообщение из очереди не отправлено, чтобы не будить её. Оно осталось в очереди.',
          { messageCode: 'run-group-paused' },
        );
      }

      // Слово «на ходу», а ход уже кончился (между проверкой вкладки и этой):
      // новый прогон здесь же, а вкладка поставила бы то же слово в очередь —
      // оно ушло бы дважды (ревью PR #1). Отказ, и вкладка дошлёт сама. Ответ
      // ребёнку из хаба (`queueIfBusy`) по-прежнему заводит ход.
      if (body.steer && !body.queueIfBusy) {
        return refuse(
          reply,
          409,
          'run_steer_ended',
          'Ход уже закончился — сообщение посреди хода не отправлено; панель отправит его обычным порядком.',
          {
            messageCode: 'run-steer-ended',
          },
        );
      }

      // Пустое сообщение без вложений: панель его не шлёт, а телефон или прямой
      // вызов API могут. CLI на пустой ввод отвечает ошибкой уже после запуска —
      // прогон, транскрипт с пустой репликой и красная точка ради ничего.
      if (!prompt.trim() && (files ?? []).length === 0) {
        return refuse(reply, 400, 'empty_prompt', 'Сообщение пустое — отправлять нечего.', {
          messageCode: 'run-empty-prompt',
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
          {
            files: names,
            supported: SUPPORTED_UPLOAD_EXTENSIONS,
            messageCode: 'run-unsupported-upload',
            params: { names: names.join(', '), supported: SUPPORTED_UPLOAD_EXTENSIONS.join(', ') },
          },
        );
      }

      // `sessionId` — обещание продолжить ЕСТЬ разговор. Без транскрипта
      // продолжать нечего, а молчаливый запуск стоил дорого: живой прогон
      // 24.09.2026 — отправка с `sessionId: ".jsonl"` в чат группы завела под тем
      // же chatId СВЕЖУЮ сессию без истории, а UUID без транскрипта кончался
      // голым «Запрос не выполнен». Имя проверяется целиком, а не после чистки:
      // поиск транскрипта выбрасывает лишние знаки и нашёл бы чужой разговор.
      // Пустая строка — «сессии нет», как и раньше: CLI её тоже не продолжает.
      if (
        sessionId &&
        !(/^[A-Za-z0-9-]+$/.test(sessionId) && findTranscript(projectsDir(ctx), sessionId))
      ) {
        return refuse(
          reply,
          404,
          'session_unknown',
          `Разговор ${sessionId} не найден: транскрипта с таким sessionId нет. Сообщение не отправлено — новый разговор без sessionId начинается отдельно.`,
          { sessionId, messageCode: 'run-session-unknown', params: { sessionId } },
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

      // Копия репозитория обязана быть полной ДО первого хода агента: без
      // локального слоя и записи доступа он либо спросит человека то, на что
      // тот уже отвечал, либо молча сделает работу без своих переходников.
      // Сначала панель добирает недостачу сама и только потом отказывает.
      const copyState = await readinessForCwd(workspace.cwd, ctx.location.paths.mcpConfig);
      if (!copyState.ready && copyState.mainDir) {
        const repaired = await repairCopy({
          mainDir: copyState.mainDir,
          copyDir: workspace.cwd,
          mirror: ctx.store.getWorktreeMirror(copyState.mainDir),
          claudeJsonPath: ctx.location.paths.mcpConfig,
        });
        if (!repaired.ready) {
          const gaps = describeGaps(repaired.gaps);
          return refuse(
            reply,
            422,
            'copy_not_ready',
            `Копия ${workspace.cwd} неполная: ${gaps}. Панель попробовала добрать недостающее и не смогла — агент в такой копии работал бы не с тем окружением.`,
            {
              cwd: workspace.cwd,
              gaps: repaired.gaps,
              messageCode: 'run-copy-not-ready',
              params: { cwd: workspace.cwd, gaps },
            },
          );
        }
      }

      if (workspace.isMissing) {
        return refuse(
          reply,
          422,
          'workspace_missing',
          `Рабочая папка этого чата не найдена: ${workspace.cwd}. Разговор начинался в ней, и продолжить его можно только оттуда.`,
          {
            cwd: workspace.cwd,
            messageCode: 'run-workspace-missing',
            params: { cwd: workspace.cwd },
          },
        );
      }

      const cwd = workspace.cwd;

      // Набор, привязанный к этому проекту, включается сам — до запуска агента,
      // иначе правила и скиллы доехали бы только к следующему сообщению. Уже
      // включённая группа не трогается вовсе, поэтому вызов на каждом сообщении
      // ничего не стоит. Песочница исключена: у неё свой каталог конфигурации.
      // Осечка тут не имеет права ронять прогон — набор не главнее разговора.
      let activatedGroups: string[] = [];
      if (!workspace.isSandbox) {
        try {
          const toggle = { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir };
          activatedGroups = activateGroupsForCwd(toggle, cwd).activated;
          // Группу, выбранную в меню чата (своя или от родителя), включает сам
          // реестр на старте (`group-activation-wiring.ts`) — одна точка на все
          // старты, и отправка человека её не дублирует.
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

      // Авторежим этого чата (владелец, 24.09.2026). Выбор человека в чате —
      // поле отправки или тумблер, запомненный сервером, — сильнее глобальной
      // `chatAutoMode` в обе стороны; не выбирал — чат идёт за ней. Тот же
      // авторежим включает и автоподтверждение панели: у моделей без авторежима
      // CLI (haiku, чужие CLI) рутину снимает именно оно, а безвозвратное и
      // правила `ask`/`deny` по-прежнему уходят человеку (`auto-approve.ts`).
      if (autoApproveRequested !== undefined) {
        session.setAutoModeOverride(chatId, autoApproveRequested);
      }
      const autoOverride = autoApproveRequested ?? session.autoModeOverride(chatId, sessionId);
      const autoMode = autoOverride ?? ctx.store.getSettings().chatAutoMode;
      session.armAutoApprove(chatId, {
        enabled: autoMode,
        // «Только чтение» — это выключенный тумблер правок в настоящем проекте;
        // в песочнице и при полном доступе правки разрешены всегда.
        allowEdits: workspace.isSandbox || allowEdits === true || fullAccess === true,
        // Положение из глобальной настройки — не решение человека в этом чате:
        // строки вкладки «Группы» ему не уступают, как и тумблеру родителя.
        ...(autoOverride === undefined ? { inherited: true as const } : {}),
      });

      // Что назначено ЭТОМУ чату при разделении. Ключей у разговора два —
      // временный и настоящий `sessionId`, — поэтому смотрим оба: связь
      // переезжает на второй, но вкладка ещё помнит первый.
      const assigned =
        ctx.store.getChatLink(chatId) ?? (sessionId ? ctx.store.getChatLink(sessionId) : undefined);

      // Доставка до MR — обычному чату проекта; ребёнок разделения получает её
      // заданием группы, а песочнице доставлять некуда.
      const delivery =
        workspace.isSandbox || assigned ? undefined : chatDeliveryFor(ctx.store, cwd);
      const initiative = initiativePrompt(ctx.store.getSettings(), delivery ? { delivery } : {});

      // Веер ручного параллельного запуска, отправленный ступенью НИЖЕ потолка
      // разговора. Плата за понижение тут одна — планка сдачи, и про это в
      // задании сказано прямо: конвейер «работа → ревью → фикс» живёт на связи
      // разделения и на копии ветки, а прогоны веера идут в настоящих проектах,
      // где ни того, ни другого нет. Обещать ревью значило бы соврать агенту.
      // Чат группы разделения получает дописку своего звена, а не обычного
      // разговора (`childAppendPrompt`): ответ человека в него — тот же ход
      // группы, и делить его дальше не предлагается.
      const appendSystemPrompt =
        (assigned && !workspace.isSandbox
          ? // Та же сборка, что у продолжения сессии панелью (`review-starter.ts`):
            // разойдись они, ход менял бы системный промпт сессии (E6).
            linkedChildAppend(
              ctx.store,
              ctx.location.paths.appData,
              ctx.store.getSettings(),
              sessionId ? [chatId, sessionId] : [chatId],
              cwd,
              parentChatId && parentChatId !== chatId ? parentChatId : undefined,
            )
          : [initiative ?? '', lowered ? loweredWorkPrompt(undefined, { review: false }) : '']
              .filter(Boolean)
              .join(' ')) || undefined;

      // Алиас CLI — это «рекомендованная модель уровня», не последняя в
      // семействе: `--model sonnet` уводил прогон на прошлое поколение при
      // свежем в каталоге. Разворачиваем сами (`expandAssignedModel` в
      // `domains/model-cascade`), — и у понижённой ступени,
      // и у выбора человека в шапке: пункт «Sonnet» человек читает как «свежий
      // Sonnet» (живой прогон 29.09: выбран Sonnet, шёл Sonnet 5 при вышедшем
      // 5.5). Конкретное имя модели — его точный выбор, оно едет как есть.
      const wantedModel = model;
      const runModel = wantedModel
        ? expandAssignedModel(ctx.models.current(provider.modelVendors ?? []).models, wantedModel)
        : wantedModel;

      // Связь с родителем — СТРОГО до запуска. Прогон называет свой настоящий
      // `sessionId` через пару секунд, и перенос связи ищет запись по временному
      // ключу: не найдя, он молча ничего не делает, и чат уезжает в список
      // отдельным разговором вместе со своими вопросами (3 сентября так потерялись
      // трое детей из четырёх).
      //
      // Только для НОВОГО разговора: продолжение уже существующего родителя себе
      // не назначает — иначе обычная переписка в чате-ребёнке переписывала бы
      // дерево на каждом сообщении.
      if (parentChatId && parentChatId !== chatId && !ctx.store.getChatLink(chatId)) {
        ctx.store.setChatLink(chatId, {
          parentChatId,
          ...(parentTitle ? { title: parentTitle } : {}),
          createdAt: new Date().toISOString(),
        });
      }

      // Откуда прогон для контура (Т3, найдено ревью Т8). Связь заводится
      // разделением — значит разговор со связью принадлежит дереву групп, и
      // маршрут он обязан спрашивать потребителем «Группы разделения», как это
      // делает продолжение в чистой сессии (`handoff-routes.ts`). Без этого одна переписка ходила бы
      // двумя маршрутами: реплики агента через контур, а ответ человека в том же
      // чате — мимо него, и наши слои снимались бы через раз. Связь, заведённую
      // строкой выше, считаем тоже: первое сообщение ребёнка — уже прогон дерева.
      const origin =
        assigned || (parentChatId && parentChatId !== chatId) ? ('groups' as const) : undefined;

      // Авторежим CLI — только там, где он есть: haiku CLI молча опускает до
      // `default`, и прогон спрашивал бы даже правку файла. Таким — `acceptEdits`
      // плюс автоподтверждение панели, взведённое выше.
      const cliAutoMode = autoMode && supportsCliAutoMode(provider.id, runModel || assigned?.model);

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
          // Команда запуска — Claude: чужой CLI отсечён выше, а снимок провайдера
          // тот же, что прошёл проверку.
          command: providerCliCommand(provider),
          // Модель и глубина продумывания — выбор пользователя в шапке чата.
          // Пусто — берём назначение этого чата, если оно у него есть: чат,
          // заведённый разделением, работает моделью, подобранной под род его
          // задачи, и второе сообщение обязано уехать на ней же. Панель модель
          // шлёт всегда, а телефон и API-клиенты — нет, и без этого их сообщения
          // молча возвращали бы разговор на дефолт из настроек.
          model: runModel || assigned?.model,
          effort: effort || assigned?.effort,
          // Инициативы панели (разделить задачи, закрыть этап чистой сессией) —
          // одной строкой к системному промпту. Тумблеры в настройках, потому что
          // уместны они не всякому: кто ведёт один короткий разговор, увидит в них
          // лишний шаг. Тут же планка сдачи понижённого прогона.
          ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
          // Полный доступ снимает все проверки прав — по кнопке «Разрешить и
          // продолжить» у агента, вставшего из-за отсутствия разрешения.
          // Чат дерева разделения с правом правок идёт в авторежиме, как шёл и его
          // запуск: иначе ответ человека в чате группы
          // продолжал её в `acceptEdits`, и она вставала на карточке прав, которой
          // человек не видит (живой прогон 24.09.2026).
          permissionMode: fullAccess
            ? 'bypassPermissions'
            : allowEdits && (assigned?.parentChatId || origin)
              ? AUTONOMOUS_PERMISSION_MODE
              : permissionModeFor(workspace, allowEdits, cliAutoMode),
          // Интерактивные права: запрос на инструмент вне авторазрешённого уходит
          // человеку кнопкой в чате. Передаётся всегда, но при полном доступе
          // (`bypassPermissions`) прогон брокер не подключает — подтверждать
          // нечего; вопрос агента с вариантами едет не через брокер, а следующим
          // сообщением (`QUESTION_PROMPT`, `domains/chat/initiative/initiative.ts`).
          permissionPrompt: { runId: chatId, baseUrl: selfBaseUrl, tokenFile: apiTokenPath() },
        },
        // Каталог проекта — для группировки статусов и восстановления после F5;
        // у песочницы/домашнего чата проекта нет.
        {
          projectPath: workspace.isSandbox ? undefined : cwd,
          sessionId,
          ...(origin ? { origin } : {}),
          // Понижение доезжает до реестра, а не умирает здесь: по нему прогон
          // попадёт в журнал сдачи вместе с тем, видела ли панель проверки.
          // Модель кладём УЖЕ РАЗВЁРНУТУЮ — журнал должен отвечать, чем прогон
          // шёл на самом деле, а не каким алиасом его попросили.
          ...(lowered
            ? {
                lowered: {
                  model: runModel || assigned?.model || '',
                  effort: effort || assigned?.effort || '',
                },
              }
            : {}),
        },
      );

      // Страховка на случай, если прогон успел появиться между проверкой выше и
      // запуском: подключаться к ЧУЖОМУ прогону с seq 0 нельзя — это и была
      // подмена ответа. Лучше честный отказ — с тем же ключом для подключения.
      if (!started) {
        return refuse(reply, 409, 'run_busy', RUN_BUSY_MESSAGE, {
          runId: registry.resolveKey(chatId, sessionId),
          messageCode: 'run-busy',
        });
      }
      delivered();

      // Про включившийся набор говорим ПОСЛЕ старта: до него прогона в реестре
      // нет, и заметке некуда лечь. Буфер реестра держит её наравне с событиями
      // CLI, поэтому подключение с нуля её не пропустит.
      const activationNotice = groupsActivatedNotice(activatedGroups);
      if (activationNotice) registry.emitExternal(chatId, activationNotice);

      // Доставка из очереди сервера (`queueIfBusy`): поток читать некому —
      // идущий прогон вкладки подхватят опросом.
      if (queuedByServer) {
        return reply.code(202).send({ started: true, runId: chatId });
      }
      await streamRun(registry, reply, chatId, 0);
    },
  );

  /**
   * Переподключение к идущему прогону: догнать пропущенное с `from` и слушать
   * дальше. Так клиент восстанавливает поток после обрыва связи и после
   * перезагрузки страницы. Если прогона нет — отвечаем маркером `gone`, чтобы
   * клиент прекратил переподключение, а не долбил впустую.
   *
   * `startedAt` — ход, к которому относится `from`: в разговоре успел начаться
   * другой ход — он отдаётся с начала (см. `ChatRunRegistry.attach`). Без него —
   * прежний договор, курсор как есть.
   */
  app.get<{ Params: { chatId: string }; Querystring: { from?: string; startedAt?: string } }>(
    '/api/chat/:chatId/stream',
    async (request, reply) => {
      const { chatId } = request.params;
      const fromSeq = Number(request.query.from) || 0;
      const startedAt = Number(request.query.startedAt) || undefined;

      if (!registry.has(chatId)) {
        streamGone(reply);
        return;
      }

      await streamRun(registry, reply, chatId, fromSeq, startedAt);
    },
  );

  /** Идущие прогоны — клиент подхватывает их после перезагрузки страницы. */
  app.get('/api/chat/active', () => registry.active());

  /** Накопленный за сеанс расход — счётчик в пульте переживает перезагрузку. */
  app.get('/api/chat/spend', () => registry.spend());

  app.post<{ Params: { chatId: string } }>('/api/chat/:chatId/stop', (request, reply) => {
    // Заодно отклоняем висящие запросы прав — иначе агент ждал бы решения зря.
    // До исхода и намеренно: если снять процесс не удастся (F-145), отказ в
    // правах и снятый тумблер — единственный тормоз, который у панели остался,
    // и человек, нажавший «Стоп», хотел именно его.
    session.abort(request.params.chatId);
    // «Стоп» человека: группа разделения встаёт на паузу (журнал 89c).
    const outcome = registry.stopByHuman(request.params.chatId);
    if (outcome === 'unconfirmed') {
      // Процесс жив и не снят (F-145): «остановлено» было бы неправдой. 409 —
      // прогон по-прежнему идёт; вкладка и телефон показывают текст по коду.
      return refuse(
        reply,
        409,
        'stop_unconfirmed',
        'Процесс агента не остановлен: панель не смогла проверить, что номер всё ещё его, и не тронула его. Прогон идёт дальше — попробуйте «Остановить» ещё раз.',
        { messageCode: 'chat-stop-unconfirmed' },
      );
    }
    return { ok: outcome === 'stopped' };
  });

  /**
   * «Продолжить старый разговор» на заметке остывшей сессии (R5 ревью П1):
   * новый разговор снимается, ход идёт старой сессией. 409 — повод уже прошёл:
   * ход кончился или начат не правилом остывшей сессии.
   */
  app.post<{ Params: { chatId: string } }>('/api/chat/:chatId/keep-session', (request, reply) => {
    const outcome = registry.keepColdSession(request.params.chatId);
    if (outcome === 'started') return { ok: true };
    if (outcome === 'unconfirmed') {
      return refuse(
        reply,
        409,
        'stop_unconfirmed',
        'Процесс агента не остановлен: панель не смогла проверить, что номер всё ещё его, и не тронула его. Прогон идёт дальше — попробуйте «Остановить» ещё раз.',
        { messageCode: 'chat-stop-unconfirmed' },
      );
    }
    return refuse(
      reply,
      409,
      'keep_session_gone',
      'Новый разговор уже не идёт — вернуть ход в старый нечего.',
      { messageCode: 'chat-keep-session-gone' },
    );
  });

  /**
   * Тумблер автоподтверждения, щёлкнутый во время прогона. Без этого маршрута
   * новое положение действовало бы только со следующего сообщения, а человек
   * ждёт его сразу — он же щёлкает, потому что устал жать «Разрешить».
   */
  app.post<{ Params: { chatId: string }; Body: unknown }>(
    '/api/chat/:chatId/auto-approve',
    { preHandler: humanOnly(humanDeps) },
    async (request, reply) => {
      // Запрос без тела значит «выключено», а не 500 — на пустом или обрезанном
      // теле панель не должна выглядеть сломанной; кривое тело — 400 с полем.
      const body = parseBody(autoApproveBodySchema, request.body, reply);
      if (body === undefined && reply.sent) return reply;
      session.toggleAutoApprove(request.params.chatId, body?.enabled === true);
      return { ok: true };
    },
  );

  /**
   * Авторежим прав чата: что действует, выбирал ли его человек в этом чате и
   * что стоит глобально. По нему меню чата показывает тумблер — выбор живёт на
   * сервере, а не в браузере: прогоны чата заводит и панель, без вкладки.
   */
  app.get<{ Params: { chatId: string }; Querystring: { sessionId?: string } }>(
    '/api/chat/:chatId/auto-mode',
    (request): ChatAutoModeView => {
      const global = ctx.store.getSettings().chatAutoMode;
      const override = session.autoModeOverride(request.params.chatId, request.query.sessionId);
      const { sessionId } = request.query;
      const edits = (
        session.autoApproveFor(request.params.chatId) ??
        (sessionId ? session.autoApproveFor(sessionId) : undefined)
      )?.allowEdits;
      return {
        enabled: override ?? global,
        ...(override !== undefined ? { override } : {}),
        global,
        ...(edits !== undefined ? { allowEdits: edits } : {}),
      };
    },
  );

  /**
   * Запрос на разрешение от мини-MCP-сервера прав. Показываем его в потоке
   * разговора карточкой и держим ответ, пока человек не решит. Ответ уходит
   * обратно серверу прав, а он — агенту. Разговора нет (уже закрыт) → запрещаем.
   */
  // Долгое решение прав — строкой в журнал сервера (журнал 26.10, #g8:30: вызов
  // группы шёл 131 с, команда — 0,07 с, а где стояла панель — не восстановить).
  // Карточка человеку тоже долгая — строка называет вызов, сверка — по D-n.
  /** Решение пользователя по запросу прав (клик «Разрешить»/«Запретить»). */
  app.post<{ Params: { chatId: string }; Body: unknown }>(
    '/api/chat/:chatId/permission-decision',
    { preHandler: humanOnly(humanDeps) },
    async (request, reply) => {
      const { chatId } = request.params;
      const body = parseBody(permissionDecisionBodySchema, request.body, reply);
      if (!body) return reply;
      const { toolUseId, behavior, message } = body;
      // Вопрос права задачи ядра отвечает браузер командой ядра: ответ этого сервера ядро
      // отвергло бы (`answer` — human-strict, 06 §Authority). Отказ по имени, не тихое «принято».
      if (isCorePermitCard(session.pendingPermissions(), toolUseId)) return refuseCorePermit(reply);
      const outcome = session.answerPermission(
        chatId,
        toolUseId,
        behavior === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: message ?? 'Denied by the user.' },
      );
      // Умерший запрос — не «принято»: CLI его уже не ждёт, и человек обязан
      // узнать, что его «Разрешить» ничего не запустило.
      if (outcome === 'expired') return refuseExpired(reply);
      // «Отложено» — тоже принято: панель только что поднялась, мост прав
      // повторит вопрос, и ответ уйдёт агенту с повтором.
      return { ok: outcome === 'ok' || outcome === 'held' };
    },
  );
}
