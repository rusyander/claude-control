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
  listPanelAgentConversations,
  readPanelAgentConversation,
  writePanelAgentConversation,
} from '../../domains/panel-agent/conversations.ts';
import { maskPanelAgentMessages } from '../../domains/panel-agent/data-mask.ts';
import { resolvePanelAgentLaunch } from '../../domains/panel-agent/launch.ts';
import { startPanelAgentRun } from '../../domains/panel-agent/runner.ts';
import { SSE_HEADERS } from '../../domains/chat/ChatStream.ts';
import type { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { PanelAgentProcesses } from '../../domains/panel-agent/processes.ts';

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
});

/**
 * Ход агента панели (А2): отказ до запуска — JSON с кодом, иначе поток SSE тех
 * же кадров, что у чата (`data: <json>`), чтобы окно разбирало его знакомым
 * читателем. Закрытое окно останавливает процесс: ждущая карточка при этом
 * снимается сама — переходник умирает, запрос к действию обрывается.
 */
export function registerPanelAgentRunRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: PanelAgentRunRouteDeps,
): void {
  // Один ход на разговор: второй параллельный ход писал бы в тот же файл.
  const running = new Set<string>();
  const appData = (): string => ctx.location.paths.appData;
  const processes = deps.processes ?? new PanelAgentProcesses(appData);

  const refuse = (code: PanelAgentRunRefusal['error'], message: string): PanelAgentRunRefusal => ({
    error: code,
    message,
  });

  app.post<{ Body: unknown }>('/api/agent/run', async (request, reply) => {
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(body)'}: ${issue.message}`)
        .join('; ');
      return reply.code(400).send(refuse('invalid_body', message));
    }
    const body = parsed.data;
    const conversationId = body.conversationId ?? randomUUID();
    if (running.has(conversationId)) {
      return reply
        .code(409)
        .send(refuse('busy', 'В этом разговоре агент ещё отвечает — дождитесь конца хода.'));
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
    const messages = masked.messages;

    running.add(conversationId);
    // Разговор пишется ДО запуска: `where_am_i` читает страницу человека из файла.
    writePanelAgentConversation(appData(), conversationId, body.context, messages);

    reply.raw.writeHead(200, SSE_HEADERS);
    let open = true;
    const send = (event: PanelAgentRunEvent): void => {
      if (!open) return;
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Соединение закрыто — обработчик close остановит ход.
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
    reply.raw.on('close', () => {
      if (reply.raw.writableEnded) return;
      open = false;
      run.stop();
    });

    try {
      const result = await run.done;
      if (result.ok) {
        writePanelAgentConversation(appData(), conversationId, body.context, [
          ...messages,
          { role: 'assistant', content: result.reply },
        ]);
      }
    } finally {
      running.delete(conversationId);
      clearInterval(heartbeat);
      open = false;
      reply.raw.end();
    }
    return reply;
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
      return reply.code(404).send({ error: 'not_found', message: 'Такого разговора нет.' });
    }
    return conversation;
  });
}
