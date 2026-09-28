import type { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  PanelAgentConversation,
  PanelAgentConversationSummary,
  PanelAgentRunEvent,
  PanelAgentRunRefusal,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_CONVERSATION_ID } from '@agentdeck/contracts/panel-agent';
import type { ServerContext } from '../../context.ts';
import {
  closePanelAgentTurn,
  deletePanelAgentConversation,
  isDeletedPanelAgentConversation,
  isStalePanelAgentHistory,
  listPanelAgentConversations,
  readPanelAgentConversation,
  recordPanelAgentTurnProgress,
  writePanelAgentConversation,
} from '../../domains/panel-agent/conversations.ts';
import { maskPanelAgentMessages } from '../../domains/panel-agent/data-mask.ts';
import { resolvePanelAgentLaunch } from '../../domains/panel-agent/launch.ts';
import { startPanelAgentRun } from '../../domains/panel-agent/runner.ts';
import { SSE_HEADERS } from '../../domains/chat/ChatStream.ts';
import type { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { PanelAgentProcesses } from '../../domains/panel-agent/processes.ts';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import { singleIssueCode } from '../../lib/zod-issue-codes.ts';
import { readAgentImages } from '../../lib/agent-images.ts';
import { TurnFeed, seqFrame } from '../../domains/panel-agent/turn-feed.ts';

export interface PanelAgentRunRouteDeps {
  /** Адрес панели для переходника: `http://127.0.0.1:<port>`. */
  selfBaseUrl: string;
  /** Порт живого шлюза контура; 0 — не поднят. */
  gatewayPort: () => number;
  /** Подмены для проверок. */
  spawnImpl?: typeof nodeSpawn;
  detect?: (command: string) => boolean;
  bridgeScript?: string;
  /** Ждущие карточки: пока у разговора висит карточка, потолок хода стоит. */
  pending?: PanelPendingActions;
  /** Журнал процессов агента; по умолчанию — в каталоге данных панели. */
  processes?: PanelAgentProcesses;
  /** Потолок хода и шаг его счёта — подмена для проверок. */
  timeoutMs?: number;
  ceilingTickMs?: number;
  /** Сколько отцепившийся ход ждёт возвращения клиента — подмена для проверок. */
  detachGraceMs?: number;
  /** Сколько законченный ход отдаёт свои кадры опоздавшему клиенту. */
  lingerMs?: number;
}

/**
 * Ход, начатый с `detach`, без единого клиента живёт столько — потом снимается,
 * как снимался бы с обрывом: карточка без человека не должна висеть часами.
 * Десять минут — с запасом на «ответил на звонок и вернулся в приложение».
 */
const DETACH_GRACE_MS = 10 * 60_000;
/** Законченный ход ещё минуту отдаёт кадры: клиент мог вернуться к самому концу. */
const LINGER_MS = 60_000;

/** Идущий (или только что законченный) ход с кадрами для догоняющего клиента. */
interface LiveTurn {
  feed: TurnFeed;
  stop: () => void;
  /** Ход переживает обрыв запроса; без флага обрыв его снимает, как прежде. */
  detach: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
}

const contextSchema = z.object({
  route: z.string().trim().min(1).max(500),
  title: z.string().max(200).optional(),
  projectPath: z.string().max(1000).optional(),
});

const runSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(50_000),
      }),
    )
    .min(1)
    .max(200)
    .refine((messages) => messages[messages.length - 1]?.role === 'user', {
      message: 'последняя реплика должна быть человека',
    }),
  conversationId: z.string().regex(PANEL_AGENT_CONVERSATION_ID).optional(),
  context: contextSchema,
  // Картинки проверяет `readAgentImages` — с именем файла в отказе, а не путём схемы.
  images: z.unknown().optional(),
  // Клиент вернётся за ходом сам (`GET …/stream?fromSeq`): обрыв запроса ход не
  // снимает, кадры идут с номерами. Окно панели флага не шлёт — у него закрытое
  // окно по-прежнему останавливает агента.
  detach: z.boolean().optional(),
});

const fromSeqSchema = z.coerce.number().int().min(0).default(0);

/**
 * Тело хода с картинками: до восьми по 3,75 МБ, в base64 на треть длиннее.
 * Предел Fastify по умолчанию (1 МБ) отказал бы уже одному снимку экрана.
 */
const RUN_BODY_LIMIT = 48 * 1024 * 1024;

/** Сколько итогов действий помнить на разговор и сколько разговоров держать. */
const ACTION_MEMORY_PER_CONVERSATION = 20;
const ACTION_MEMORY_CONVERSATIONS = 50;

/** Дописать итоги хода: свежие в конце, старые разговоры вытесняются первыми. */
function rememberActions(memory: Map<string, string[]>, id: string, actions: string[]): void {
  if (actions.length === 0) return;
  const kept = [...(memory.get(id) ?? []), ...actions].slice(-ACTION_MEMORY_PER_CONVERSATION);
  memory.delete(id);
  memory.set(id, kept);
  while (memory.size > ACTION_MEMORY_CONVERSATIONS) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/**
 * Ход агента панели (А2): отказ до запуска — JSON с кодом, иначе поток SSE тех
 * же кадров, что у чата (`data: <json>`), чтобы окно разбирало его знакомым
 * читателем. Закрытое окно останавливает процесс: ждущая карточка при этом
 * снимается сама — переходник умирает, запрос к действию обрывается. Ход с
 * `detach` (телефон) обрыв переживает: клиент возвращается за кадрами по номеру.
 */
export function registerPanelAgentRunRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: PanelAgentRunRouteDeps,
): void {
  // Один ход на разговор: второй параллельный ход писал бы в тот же файл.
  const running = new Set<string>();
  // Кадры идущих ходов по разговору — для клиента, вернувшегося после обрыва.
  const turns = new Map<string, LiveTurn>();
  const graceMs = deps.detachGraceMs ?? DETACH_GRACE_MS;
  const lingerMs = deps.lingerMs ?? LINGER_MS;
  /** Ход остался без клиентов — ждём возвращения, потом снимаем. */
  const armGrace = (turn: LiveTurn): void => {
    if (!turn.detach || turn.feed.ended || turn.feed.subscribers > 0) return;
    clearTimeout(turn.graceTimer);
    turn.graceTimer = setTimeout(() => {
      if (turn.feed.subscribers === 0 && !turn.feed.ended) turn.stop();
    }, graceMs);
    turn.graceTimer.unref?.();
  };
  // Итоги действий прошлых ходов по разговору: история окна хранит только ответы
  // словами, а ключ запущенного чата или id нового правила нужен следующему ходу.
  // Живёт в памяти процесса — после перезапуска панели ход просто читает заново.
  const actionMemory = new Map<string, string[]>();
  const appData = (): string => ctx.location.paths.appData;
  const processes = deps.processes ?? new PanelAgentProcesses(appData);

  const refuse = (
    code: PanelAgentRunRefusal['error'],
    message: string,
    messageCode?: ServerMessageCode,
  ): PanelAgentRunRefusal & { messageCode?: ServerMessageCode } => ({
    error: code,
    message,
    ...(messageCode ? { messageCode } : {}),
  });

  app.post<{ Body: unknown }>(
    '/api/agent/run',
    { bodyLimit: RUN_BODY_LIMIT },
    async (request, reply) => {
      const parsed = runSchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || '(body)'}: ${issue.message}`)
          .join('; ');
        return reply
          .code(400)
          .send(refuse('invalid_body', message, singleIssueCode(parsed.error.issues)));
      }
      const body = parsed.data;
      const images = readAgentImages(body.images);
      if (!images.ok) return reply.code(400).send(images.refusal);
      const conversationId = body.conversationId ?? randomUUID();
      if (running.has(conversationId)) {
        return reply
          .code(409)
          .send(
            refuse(
              'busy',
              'В этом разговоре агент ещё отвечает — дождитесь конца хода.',
              'panel-agent-busy',
            ),
          );
      }

      const launch = resolvePanelAgentLaunch({
        store: ctx.store,
        appDataDir: appData(),
        gatewayPort: deps.gatewayPort,
        detect: deps.detect,
      });
      if (!launch.ok) return reply.code(409).send(refuse(launch.code, launch.message));

      // Маска — до ВСЕГО, что уносит текст из запроса: и до модели, и до файла
      // разговора. Ключ, вставленный в сообщение, не должен лечь и на диск панели.
      const masked = maskPanelAgentMessages(appData(), body.messages);
      if (!masked.ok) return reply.code(409).send(refuse('data_mask_broken', masked.message));

      // Разговор удалили в другой вкладке: ход окна с его историей вернул бы его в «Историю».
      if (
        body.conversationId !== undefined &&
        isDeletedPanelAgentConversation(appData(), conversationId, masked.messages)
      ) {
        return reply
          .code(409)
          .send(
            refuse(
              'conversation_deleted',
              'Этот разговор удалили в другой вкладке — следующее сообщение начнёт новый.',
            ),
          );
      }

      // Вкладка, отставшая от разговора, не переписывает его своей историей: ход
      // другой вкладки пропал бы из файла молча (проверено двумя вкладками вживую).
      if (
        body.conversationId !== undefined &&
        isStalePanelAgentHistory(appData(), conversationId, masked.messages)
      ) {
        return reply
          .code(409)
          .send(
            refuse(
              'conversation_stale',
              'Этот разговор продолжили в другой вкладке — откройте его заново из «Истории».',
            ),
          );
      }

      running.add(conversationId);
      // Разговор пишется ДО запуска: `where_am_i` читает страницу человека из файла.
      // История — записанная, а не присланная: окно, видевшее обрыв, теряет
      // запечатанный ответ оборванного хода, файл его возвращает.
      const messages = writePanelAgentConversation(
        appData(),
        conversationId,
        body.context,
        masked.messages,
      ).messages.map(({ role, content }) => ({ role, content }));
      // Сказанное и сделанное — в файл по ходу: перезапуск панели посреди хода
      // иначе стирал ход целиком, с одобренными и выполненными действиями.
      const progress = { texts: [] as string[], actions: [] as string[] };
      const track = (event: PanelAgentRunEvent): void => {
        if (event.kind === 'text') progress.texts.push(event.text);
        else if (event.kind === 'tool-result') {
          // Список действий уходит модели запечатанным ответом — пометка английская.
          progress.actions.push(event.isError ? `${event.name} (failed)` : event.name);
        } else return;
        try {
          recordPanelAgentTurnProgress(appData(), conversationId, progress);
        } catch {
          // Файл не записался — ход идёт дальше, итог допишет конец хода.
        }
      };

      reply.raw.writeHead(200, SSE_HEADERS);
      let open = true;
      const detach = body.detach === true;
      const feed = new TurnFeed();
      const send = (event: PanelAgentRunEvent): void => {
        track(event);
        const frame = feed.push(event);
        if (!open) return;
        try {
          // Номер кадра — только тому, кто вернётся за ходом: окно панели читает прежний вид.
          reply.raw.write(detach ? seqFrame(frame) : `data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Соединение закрыто — обработчик close остановит ход (или отцепит его).
        }
      };
      const heartbeat = setInterval(() => {
        if (open) reply.raw.write(': ping\n\n');
      }, 10_000);

      send({
        kind: 'start',
        conversationId,
        providerId: launch.providerId,
        ...(launch.contourId ? { contourId: launch.contourId } : {}),
      });

      const run = startPanelAgentRun({
        command: launch.command,
        env: launch.env,
        selfBaseUrl: deps.selfBaseUrl,
        conversationId,
        context: body.context,
        messages,
        priorActions: actionMemory.get(conversationId) ?? [],
        ...(images.images.length > 0 ? { images: images.images } : {}),
        ...(launch.contourPrompt ? { contourPrompt: launch.contourPrompt } : {}),
        onEvent: send,
        spawnImpl: deps.spawnImpl,
        bridgeScript: deps.bridgeScript,
        waitingHuman: () => deps.pending?.hasOpenFor(conversationId) ?? false,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
        ...(deps.ceilingTickMs === undefined ? {} : { ceilingTickMs: deps.ceilingTickMs }),
        onSpawn: (pid) => processes.started(conversationId, pid, appData()),
        onExit: () => processes.exited(conversationId),
      });
      const turn: LiveTurn = { feed, stop: () => run.stop(), detach };
      if (detach) turns.set(conversationId, turn);
      reply.raw.on('close', () => {
        if (reply.raw.writableEnded) return;
        open = false;
        // Обрыв у хода с `detach` — не «Стоп»: клиент (телефон в фоне) вернётся
        // за кадрами; не вернётся за срок — ход снимется сам.
        if (detach) armGrace(turn);
        else run.stop();
      });

      try {
        const result = await run.done;
        // И у оборванного хода: действия, одобренные до обрыва, уже выполнены.
        rememberActions(actionMemory, conversationId, result.actions);
        if (result.ok) {
          writePanelAgentConversation(appData(), conversationId, body.context, [
            ...messages,
            { role: 'assistant', content: result.reply },
          ]);
        } else {
          closePanelAgentTurn(
            appData(),
            conversationId,
            result.seal?.reason ?? 'failed',
            result.seal?.detail,
          );
        }
      } finally {
        running.delete(conversationId);
        clearInterval(heartbeat);
        clearTimeout(turn.graceTimer);
        feed.end();
        if (detach) {
          // Кадры законченного хода ещё отдаются опоздавшему — потом забываются.
          setTimeout(() => {
            if (turns.get(conversationId) === turn) turns.delete(conversationId);
          }, lingerMs).unref?.();
        }
        open = false;
        reply.raw.end();
      }
      return reply;
    },
  );

  /**
   * Вернуться к ходу после обрыва: кадры после `fromSeq`, дальше — вживую до
   * конца хода. 404 — хода нет (кончился давно или начат без `detach`), 410 —
   * начало уже вытеснено; в обоих случаях правда в файле разговора.
   */
  app.get<{ Params: { id: string }; Querystring: { fromSeq?: string } }>(
    '/api/agent/run/:id/stream',
    async (request, reply) => {
      const turn = turns.get(request.params.id);
      if (!turn) {
        return reply.code(404).send({
          error: 'not_running',
          message: 'В этом разговоре ход не идёт.',
          messageCode: 'panel-agent-not-running',
        });
      }
      const fromSeq = fromSeqSchema.safeParse(request.query.fromSeq);
      if (!fromSeq.success) {
        return reply.code(400).send({
          error: 'invalid_query',
          message: 'Номер кадра (fromSeq) должен быть числом.',
          messageCode: 'panel-agent-bad-from-seq',
        });
      }
      const missed = turn.feed.since(fromSeq.data);
      if (!missed) {
        return reply.code(410).send({
          error: 'gone',
          message: 'Начало хода уже не хранится — откройте разговор.',
          messageCode: 'panel-agent-turn-gone',
        });
      }

      reply.raw.writeHead(200, SSE_HEADERS);
      for (const frame of missed) reply.raw.write(seqFrame(frame));
      if (turn.feed.ended) {
        reply.raw.end();
        return reply;
      }
      clearTimeout(turn.graceTimer);
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 10_000);
      const unsubscribe = turn.feed.subscribe((frame) => {
        if (frame === 'end') {
          clearInterval(heartbeat);
          reply.raw.end();
          return;
        }
        try {
          reply.raw.write(seqFrame(frame));
        } catch {
          // Соединение закрыто — отпишемся в обработчике close.
        }
      });
      reply.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        armGrace(turn);
      });
      return reply;
    },
  );

  /** «Стоп» для хода с `detach`: обрыв запроса его больше не снимает. */
  app.post<{ Params: { id: string } }>('/api/agent/run/:id/stop', (request, reply) => {
    const turn = turns.get(request.params.id);
    if (!turn || turn.feed.ended) {
      return reply.code(404).send({
        error: 'not_running',
        message: 'В этом разговоре ход не идёт.',
        messageCode: 'panel-agent-not-running',
      });
    }
    turn.stop();
    return { ok: true };
  });

  app.get('/api/agent/conversations', (): PanelAgentConversationSummary[] =>
    listPanelAgentConversations(appData()),
  );

  app.get<{ Params: { id: string } }>('/api/agent/conversations/:id', (request, reply) => {
    const conversation: PanelAgentConversation | undefined = readPanelAgentConversation(
      appData(),
      request.params.id,
    );
    if (!conversation) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'Такого разговора нет.',
        messageCode: 'panel-conversation-not-found',
      });
    }
    return conversation;
  });

  app.delete<{ Params: { id: string } }>('/api/agent/conversations/:id', (request, reply) => {
    const { id } = request.params;
    // Идущий ход допишет файл в конце: удалённый разговор вернулся бы сам.
    if (running.has(id)) {
      return reply.code(409).send({
        error: 'conversation_running',
        message: 'В этом разговоре идёт ход — удалить его можно после ответа агента.',
        messageCode: 'panel-conversation-running',
      });
    }
    if (!deletePanelAgentConversation(appData(), id)) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'Такого разговора нет.',
        messageCode: 'panel-conversation-not-found',
      });
    }
    actionMemory.delete(id);
    return { ok: true };
  });
}
