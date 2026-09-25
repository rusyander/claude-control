import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import { initiativePrompt, QUESTION_DENIED } from '../../domains/chat/initiative.ts';
import { childAppendPrompt } from '../../domains/chat/ChatCascadeStages.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry.ts';
import { RUN_UNKNOWN_DENIED } from '../../domains/chat/run-ledger.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import { apiTokenPath, readApiToken } from '../../lib/api-token.ts';
import { shouldAutoApprove, isReadOnlyTool } from '../../domains/chat/auto-approve.ts';
import {
  BRANCH_GATE_STOPPED,
  branchGateHandedDenial,
  branchContinuePrompt,
  branchMovedDenial,
  isMainWorkingCopy,
  isWritingCall,
  mainCopyTargetOf,
  outsideCopyDenial,
  suggestBranchName,
} from '../../domains/chat/ChatBranchGate.ts';
import { addWorktree, chatDeliveryFor, GitError } from '../../domains/project-git.ts';
import { createGuardedPatternsReader } from '../../domains/permissions.ts';
import { chatDirectory } from '../../domains/chat/ChatArtifacts.ts';
import { findTranscript } from '../../domains/chat/ChatTranscriptFile.ts';
import {
  AUTONOMOUS_PERMISSION_MODE,
  resolveWorkspace,
  permissionModeFor,
} from '../../domains/chat/ChatWorkspace.ts';
import {
  saveUpload,
  isSupportedUpload,
  buildPromptWithFiles,
  SUPPORTED_UPLOAD_EXTENSIONS,
} from '../../domains/chat/ChatUploads.ts';
import { activateGroupsForCwd, groupsActivatedNotice } from '../../domains/group-activation.ts';
import {
  describeGaps,
  readinessForCwd,
  repairCopy,
} from '../../domains/project-git/copy-readiness.ts';
import { cascadeCeilingFor, expandAssignedModel } from '../../domains/model-cascade.ts';
import { loweredWorkPrompt } from '@agentdeck/contracts/model-cascade';
import { activeCliCommand } from '../../providers/cli.ts';
import { getActiveProvider, getActiveProviderId } from '../../providers/registry.ts';
import { supportsCliAutoMode } from '../../providers/auto-mode.ts';
import type { ChatAutoModeView } from '@agentdeck/contracts';
import { estimateCost } from '../../domains/analytics/pricing.ts';
import { projectsDir, validTargetCwd } from './paths.ts';
import { streamRun, streamGone } from '../../domains/chat/ChatStream.ts';
import {
  QUEUED_SEND_HEADER,
  QueuedSendJournal,
  queueAfterRun,
  type QueuedSend,
} from '../../domains/chat/busy-send-queue.ts';
import { parseBody } from '../../lib/request-body.ts';
import { allowedPermissionRules } from '@agentdeck/contracts/permission-rules';
import {
  groupAutoApproveFor,
  groupDecision,
  recordGroupAutoNotice,
} from '../../domains/chat/group-permissions.ts';
import {
  autoApproveBodySchema,
  branchDecisionBodySchema,
  chatSendBodySchema,
  permissionDecisionBodySchema,
  permissionRequestBodySchema,
} from '@agentdeck/contracts/request-bodies';

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
          return reply.code(202).send({ queued: true, runId });
        }
        return refuse(reply, 409, 'run_busy', RUN_BUSY_MESSAGE, {
          runId,
          messageCode: 'run-busy',
        });
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
          activatedGroups = activateGroupsForCwd(
            { paths: ctx.location.paths, store: ctx.store, backupDir: ctx.backupDir },
            cwd,
          ).activated;
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

      // Потолок для подбора — модель этого разговора: оверрайд шапки, иначе
      // настройка. Правило выключено в проекте → `undefined`, и про классы
      // работы агенту не говорится ни слова.
      const ceiling = cascadeCeilingFor(
        { entries: ctx.store.getProjectCascadeEntries(), settings: ctx.store.getSettings() },
        cwd,
        { model, effort },
      );
      // Доставка до MR — обычному чату проекта; ребёнок разделения получает её
      // заданием группы, а песочнице доставлять некуда.
      const delivery =
        workspace.isSandbox || assigned ? undefined : chatDeliveryFor(ctx.store, cwd);
      const initiative = initiativePrompt(ctx.store.getSettings(), {
        splitMuted: registry.isSplitMuted(chatId),
        ...(ceiling ? { cascade: ceiling } : {}),
        ...(delivery ? { delivery } : {}),
      });

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
          ? childAppendPrompt(assigned, ctx.store.getSettings())
          : [initiative ?? '', lowered ? loweredWorkPrompt(undefined, { review: false }) : '']
              .filter(Boolean)
              .join(' ')) || undefined;

      // Ступень лестницы приходит алиасом, а алиас CLI — это «рекомендованная
      // модель уровня», не последняя в семействе: `--model sonnet` уводил прогон
      // на прошлое поколение при свежем в каталоге. Разворачиваем сами, ровно как
      // разделение (`expandAssignedModel` в `split-routes.ts`). Только у
      // понижённого: модель, выбранная человеком в шапке, — его выбор, и
      // подменять её нечем и незачем.
      const runModel = lowered
        ? expandAssignedModel(
            ctx.models.current(getActiveProvider(ctx.store).modelVendors ?? []).models,
            model ?? '',
          )
        : model;

      // Связь с родителем — СТРОГО до запуска. Прогон называет свой настоящий
      // `sessionId` через пару секунд, и перенос связи ищет запись по временному
      // ключу: не найдя, он молча ничего не делает, и чат уезжает в список
      // отдельным разговором вместе со своими вопросами (3 сентября так потерялись
      // трое детей из четырёх, см. `SplitLink` в `domains/chat/ChatSplit.ts`).
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
      // уже делают сам запуск разделения (`split-launch.ts`) и продолжение в
      // чистой сессии (`handoff-routes.ts`). Без этого одна переписка ходила бы
      // двумя маршрутами: реплики агента через контур, а ответ человека в том же
      // чате — мимо него, и наши слои снимались бы через раз. Связь, заведённую
      // строкой выше, считаем тоже: первое сообщение ребёнка — уже прогон дерева.
      const origin =
        assigned || (parentChatId && parentChatId !== chatId) ? ('groups' as const) : undefined;

      // Авторежим CLI — только там, где он есть: haiku CLI молча опускает до
      // `default`, и прогон спрашивал бы даже правку файла. Таким — `acceptEdits`
      // плюс автоподтверждение панели, взведённое выше.
      const cliAutoMode =
        autoMode &&
        supportsCliAutoMode(getActiveProviderId(ctx.store), runModel || assigned?.model);

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
          // Чат дерева разделения с правом правок идёт в авторежиме, как и его
          // запуск (`split-launch.ts`): иначе ответ человека в чате группы
          // продолжал её в `acceptEdits`, и она вставала на карточке прав, которой
          // человек не видит (живой прогон 24.09.2026).
          permissionMode: fullAccess
            ? 'bypassPermissions'
            : allowEdits && (assigned?.parentChatId || origin)
              ? AUTONOMOUS_PERMISSION_MODE
              : permissionModeFor(workspace, allowEdits, cliAutoMode),
          // Интерактивные права: запрос на инструмент вне авторазрешённого уходит
          // человеку кнопкой в чате. При полном доступе прав не спрашивают, но
          // брокер всё равно подключается — через него же приезжает ВОПРОС агента
          // с вариантами, и без брокера отвечать на него было бы нечем.
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

      // Про включившийся набор говорим ПОСЛЕ старта: до него прогона в реестре
      // нет, и заметке некуда лечь. Буфер реестра держит её наравне с событиями
      // CLI, поэтому подключение с нуля её не пропустит.
      const activationNotice = groupsActivatedNotice(activatedGroups);
      if (activationNotice) registry.emitExternal(chatId, activationNotice);

      // Доставка из очереди сервера (`queueIfBusy`): поток читать некому —
      // идущий прогон вкладки подхватят опросом.
      if (request.headers[QUEUED_SEND_HEADER]) {
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
    // «Стоп» человека: группа разделения встаёт на паузу (журнал 89c).
    return { ok: registry.stopByHuman(request.params.chatId) };
  });

  /**
   * Тумблер автоподтверждения, щёлкнутый во время прогона. Без этого маршрута
   * новое положение действовало бы только со следующего сообщения, а человек
   * ждёт его сразу — он же щёлкает, потому что устал жать «Разрешить».
   */
  app.post<{ Params: { chatId: string }; Body: unknown }>(
    '/api/chat/:chatId/auto-approve',
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
      return {
        enabled: override ?? global,
        ...(override !== undefined ? { override } : {}),
        global,
      };
    },
  );

  /**
   * Запрос на разрешение от мини-MCP-сервера прав. Показываем его в потоке
   * разговора карточкой и держим ответ, пока человек не решит. Ответ уходит
   * обратно серверу прав, а он — агенту. Разговора нет (уже закрыт) → запрещаем.
   */
  app.post<{ Body: unknown }>('/api/chat/permission-request', async (request, reply) => {
    const body = parseBody(permissionRequestBodySchema, request.body, reply);
    if (!body) return reply;
    const { runId, toolName, input, toolUseId } = body;

    // Вопрос человеку — не запрос прав: карточку с вопросом лента уже рисует
    // по самому вызову, а ответ едет следующим сообщением. Показать здесь ещё
    // и карточку прав значило бы повесить прогон до клика по кнопке, которая
    // ничего не решает (см. `QUESTION_DENIED`).
    if (toolName === 'AskUserQuestion') {
      return reply.send({ behavior: 'deny', message: QUESTION_DENIED });
    }

    // Поздний подхват. Единственный обход журнала при старте панели мог этот
    // прогон не поймать: pid приезжает в журнал асинхронно, а `tasklist` на
    // занятой машине отвечает не всегда — и тогда живой агент получал отказ на
    // КАЖДЫЙ вызов до конца жизни. Пробуем усыновить его по журналу здесь, теми
    // же проверками; цена — одно чтение файла на неизвестный прогон. Тумблеры
    // возвращаем из снимка ДО проверки автоподтверждения ниже: иначе подхват
    // сразу поднял бы карточку там, где до перезапуска панель молчала.
    if (!registry.isRunning(runId)) {
      const adopted = registry.adoptFromLedger(runId);
      if (adopted?.autoApprove) session.armAutoApprove(adopted.key, adopted.autoApprove);
    }

    // ВОРОТА ВЕТКИ — раньше автоподтверждения, и порядок тут решает всё: правка
    // файла обратима, автоподтверждение пропустило бы её молча, и вопрос «где
    // мы вообще пишем» не прозвучал бы никогда. Стоят они не про безопасность
    // вызова, а про место: каталог у git один на всех, и первая правка делает
    // чаты проекта зависимыми друг от друга (`ChatBranchGate.ts`).
    const rules = allowedPermissionRules(ctx.store.getSettings().autoApproveRules);
    const held = registry.describe(runId);
    // Прогона нет в реестре — ни живого, ни усыновлённого из журнала: ни обходом
    // при старте (`bootstrap/runtime.ts`), ни поздним подхватом выше. Значит его
    // процесс мёртв или записи о нём нет вовсе. Отказ — раньше любого
    // автоподтверждения: с включённым по умолчанию авторежимом остановленный
    // прогон иначе получал бы молчаливое «разрешено». Текст честный и с
    // действием: он уезжает агенту результатом вызова и в транскрипт, откуда его
    // видит лента. «Разговор не найден» здесь стояло 09.09.2026 на 24 отказах за
    // секунду.
    if (!held) return reply.send({ behavior: 'deny', message: RUN_UNKNOWN_DENIED });
    if (
      !rules.has('editInMainCopy') &&
      held &&
      !session.isBranchGateSettled(runId) &&
      isWritingCall(toolName, input) &&
      isMainWorkingCopy(held.options.cwd)
    ) {
      // Имя ветки предлагаем по заданию прогона, а не по названию чата: задание
      // и есть то, ради чего ветку заводят, и в списке веток оно скажет больше.
      const branch = suggestBranchName(held.options.prompt, held.key);
      // Работа разговора отдана группам (Д15): карточка говорит кому, а копия,
      // если её всё же заведут, встанет на ветку MR детей, а не на HEAD.
      const handed = registry.branchGateContext(runId);
      const shown = registry.emitExternal(runId, {
        kind: 'branchGate',
        toolName,
        input,
        toolUseId,
        cwd: held.options.cwd,
        branch,
        ...(handed?.children.length ? { children: handed.children } : {}),
        ...(handed?.base ? { base: handed.base } : {}),
      });
      if (shown) {
        const decision = await session.requestPermission({ runId, toolName, input, toolUseId });
        registry.emitExternal(runId, {
          kind: 'permissionResolved',
          toolUseId,
          behavior: decision.behavior,
        });
        return reply.send(decision);
      }
    }
    // Прогон в своей копии пишет в основную (D4): карточка «завести копию» тут
    // ни к чему — копия уже есть, — поэтому отказ с адресом, куда писать.
    const intoMain =
      !rules.has('editInMainCopy') && held
        ? mainCopyTargetOf(held.options.cwd, toolName, input)
        : undefined;
    if (held && intoMain) {
      return reply.send({
        behavior: 'deny',
        message: outsideCopyDenial(held.options.cwd, intoMain),
      });
    }

    // Автоподтверждение: обратимый запрос разрешаем молча, не показывая
    // карточку. Человеку остаётся безвозвратное (удаление, затирание истории,
    // снос данных и инфраструктуры, публикация в чужой реестр) и всё, что
    // попадает под правила `ask`/`deny` пользователя, — граница целиком в
    // `domains/chat/auto-approve.ts`, там же и причина её выбора.
    //
    // Чтение проходит и при выключенном тумблере: посмотреть файл нечего
    // отменять, а карточка на каждый открытый файл останавливала прогон чаще
    // всего остального вместе взятого.
    const auto = session.autoApproveFor(runId);
    // Группа разделения решает по строкам вкладки «Группы» (`group-permissions.ts`):
    // её ведёт конвейер, а не браузер. Уступают строки только тумблеру, который
    // человек ВКЛЮЧИЛ в чате группы сам; унаследованный от родителя или
    // выключенный (ответ из хаба шлёт его выключенным) — не в счёт.
    const humanOn = auto?.enabled === true && auto.inherited !== true;
    const group = humanOn ? undefined : groupAutoApproveFor(ctx.store, [runId, held?.key]);
    const groupLevel = group
      ? groupDecision(group, { toolName, input, guardedPatterns: guardedPatterns() })
      : 'human';
    if (group && groupLevel !== 'human') {
      // «С отметкой»: прошло без человека, но хаб родителя это покажет.
      if (groupLevel === 'notify') recordGroupAutoNotice(ctx.store, group, { toolName, input });
      return reply.send({ behavior: 'allow', updatedInput: input });
    }
    if (
      !group &&
      (auto?.enabled || isReadOnlyTool(toolName)) &&
      shouldAutoApprove({
        toolName,
        input,
        guardedPatterns: guardedPatterns(),
        allowEdits: auto?.allowEdits ?? false,
        // Правила читаются на КАЖДЫЙ запрос (`rules` выше): тумблер щёлкают
        // ровно тогда, когда надоела карточка, и действовать он обязан со
        // следующего же вызова, а не со следующего прогона.
        allowedRules: rules,
      })
    ) {
      return reply.send({ behavior: 'allow', updatedInput: input });
    }

    // Прогон мог уйти из реестра, пока шли проверки выше, — тот же отказ.
    const shown = registry.emitExternal(runId, { kind: 'permission', toolName, input, toolUseId });
    if (!shown) return reply.send({ behavior: 'deny', message: RUN_UNKNOWN_DENIED });

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
  app.post<{ Params: { chatId: string }; Body: unknown }>(
    '/api/chat/:chatId/permission-decision',
    async (request, reply) => {
      const { chatId } = request.params;
      const body = parseBody(permissionDecisionBodySchema, request.body, reply);
      if (!body) return reply;
      const { toolUseId, behavior, message } = body;
      const ok = session.decidePermission(
        chatId,
        toolUseId,
        behavior === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: message ?? 'Отклонено пользователем.' },
      );
      return { ok };
    },
  );

  /**
   * Ответ воротам ветки. Три исхода, и только один из них что-то заводит:
   *
   * `copy` — копия с веткой от текущего HEAD, и разговор ПЕРЕЕЗЖАЕТ в неё. Тот
   * же чат, та же сессия, то же задание: прогон останавливается и поднимается
   * заново с `--resume` в новом каталоге. Переносить транскрипт при этом не надо
   * — `--resume` находит сессию независимо от каталога (проверено живьём
   * 22.09.2026), а рабочую папку разговора панель берёт из ПОСЛЕДНЕЙ записи
   * транскрипта, так что дальше чат сам считает копию своим домом.
   *
   * `here` — писать в основной копии; больше в этом прогоне не спрашиваем.
   *
   * `stop` — отклонить саму правку.
   */
  app.post<{ Params: { chatId: string }; Body: unknown }>(
    '/api/chat/:chatId/branch-decision',
    async (request, reply) => {
      const { chatId } = request.params;
      const body = parseBody(branchDecisionBodySchema, request.body, reply);
      if (!body) return reply;
      const { toolUseId, choice, branch } = body;

      if (choice === 'here') {
        session.settleBranchGate(chatId);
        return { ok: session.decidePermission(chatId, toolUseId, { behavior: 'allow' }) };
      }
      // Решение сверяется с деревом В МОМЕНТ ответа, а не со снимком карточки:
      // между ними могли пройти часы, и клиенту база копии не доверяется.
      const handed = registry.branchGateContext(chatId);
      if (choice === 'stop') {
        return {
          ok: session.decidePermission(chatId, toolUseId, {
            behavior: 'deny',
            message: handed?.children.length
              ? branchGateHandedDenial(handed.children)
              : BRANCH_GATE_STOPPED,
          }),
        };
      }

      // Снимок — ДО всего: остановка стирает прогон из реестра, а поднимать его
      // заново надо теми же параметрами (та же причина, что у паузы дерева).
      const held = registry.describe(chatId);
      if (!held) {
        return refuse(reply, 409, 'run_unknown', RUN_UNKNOWN_DENIED, {
          messageCode: 'branch-run-gone',
        });
      }
      const name = branch?.trim();
      if (!name) {
        return refuse(reply, 400, 'branch_required', 'Имя ветки не задано.', {
          messageCode: 'branch-name-required',
        });
      }

      let created: { path: string; output: string };
      try {
        created = await addWorktree(
          held.options.cwd,
          name,
          ctx.store.getWorktreeMirror(held.options.cwd),
          handed?.base,
          ctx.location.paths.mcpConfig,
        );
      } catch (error) {
        // Отказ git — не повод снимать придержанный вызов: человек поправит имя
        // и нажмёт снова, а агент всё это время честно ждёт у той же карточки.
        const text = error instanceof GitError ? error.message : String(error);
        return refuse(reply, 400, 'branch_failed', text);
      }

      // Порядок: сперва гасим прогон, потом отпускаем вызов. Наоборот агент
      // получил бы отказ и успел бы сходить куда-нибудь ещё в основной копии —
      // ровно то, ради чего ворота и стоят.
      registry.stop(held.key);
      session.decidePermission(chatId, toolUseId, {
        behavior: 'deny',
        message: branchMovedDenial(created.path, name),
      });

      const options = {
        ...held.options,
        cwd: created.path,
        prompt: branchContinuePrompt(created.path, name),
        ...(held.sessionId ? { sessionId: held.sessionId } : {}),
      };
      // Разветвление сессии здесь означало бы новый разговор — а переезжает тот
      // же самый.
      delete options.fork;
      const started = registry.start(held.key, options, {
        ...held.meta,
        projectPath: created.path,
        ...(held.sessionId ? { sessionId: held.sessionId } : {}),
      });

      return { ok: true, path: created.path, branch: name, started, output: created.output };
    },
  );
}
