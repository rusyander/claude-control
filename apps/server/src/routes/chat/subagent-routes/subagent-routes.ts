import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../../context.ts';
import {
  AGENT_ID,
  readAgentExtensions,
  readAgentTranscript,
} from '../../../domains/chat/subagent-tree/subagent-tree.ts';
import {
  historyKeys,
  readAgentHistory,
  readMainAgent,
} from '../../../domains/chat/agent-history/agent-history.ts';
import type { StepWindow } from '../../../domains/chat/subagent-tree/transcript-window.ts';
import { clampInt } from '../../../domains/chat/constants.ts';
import { sendConditional } from '../../../lib/conditional-get/conditional-get.ts';
import { projectsDir } from '../paths.ts';

/** Сколько шагов субагента отдавать за раз по умолчанию и не больше какого числа. */
const DEFAULT_STEPS = 200;
const MAX_STEPS = 1000;

/** Что панели нужно от реестра прогонов. */
export interface SubagentControl {
  /** Жив ли процесс CLI разговора — для «сейчас работают» истории агентов. */
  isProcessAlive?(chatId: string): boolean;
}

interface WindowQuery {
  limit?: string;
  offset?: string;
  start?: string;
}

/** Окно шагов из запроса: `start` — с номера шага, иначе последние со сдвигом `offset`. */
function stepWindow(query: WindowQuery): StepWindow {
  const limit = clampInt(query.limit, DEFAULT_STEPS, 1, MAX_STEPS);
  if (query.start !== undefined) {
    return { limit, start: clampInt(query.start, 0, 0, Number.MAX_SAFE_INTEGER) };
  }
  return { limit, offset: clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER) };
}

const BAD_ID = { message: 'Неверный id субагента', messageCode: 'agent-id-invalid' } as const;

/**
 * Ход субагента (только чтение) — окно шагов его транскрипта
 * `subagents/agent-<id>.jsonl`. Остановки нет: CLI — потомок ядра, stdin у панели
 * нет (s10, 03.11.2026).
 */
export function registerSubagentRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  control: SubagentControl,
): void {
  app.get<{
    Params: { chatId: string; agentId: string };
    Querystring: WindowQuery;
  }>('/api/chat/:chatId/agents/:agentId', (request, reply) => {
    const { chatId, agentId } = request.params;
    if (!AGENT_ID.test(agentId)) return reply.code(400).send(BAD_ID);
    const transcript = readAgentTranscript(
      projectsDir(ctx),
      chatId,
      agentId,
      stepWindow(request.query),
    );
    if (!transcript) {
      return reply
        .code(404)
        .send({ message: 'Субагент не найден', messageCode: 'agent-not-found' });
    }
    return transcript;
  });

  // Скиллы, хуки и MCP по времени: главного агента и субагента.
  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/extensions', (request, reply) => {
    const extensions = readAgentExtensions(projectsDir(ctx), request.params.chatId, undefined);
    if (!extensions) {
      return reply
        .code(404)
        .send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' });
    }
    return extensions;
  });

  app.get<{ Params: { chatId: string; agentId: string } }>(
    '/api/chat/:chatId/agents/:agentId/extensions',
    (request, reply) => {
      const { chatId, agentId } = request.params;
      if (!AGENT_ID.test(agentId)) return reply.code(400).send(BAD_ID);
      const extensions = readAgentExtensions(projectsDir(ctx), chatId, agentId);
      if (!extensions) {
        return reply
          .code(404)
          .send({ message: 'Субагент не найден', messageCode: 'agent-not-found' });
      }
      return extensions;
    },
  );

  // История агентов по всем сессиям разговора (у группы — все её звенья). Карточка
  // группы спрашивает её часто, а прошлые сессии не меняются — условный GET.
  // «Сейчас работают» — тот же ответ: часы и реестр живых процессов панели.
  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/agent-history', (request, reply) => {
    const { chatId } = request.params;
    const keys = historyKeys(ctx.store.getChatLinks(), chatId);
    const probe = {
      now: Date.now(),
      alive: (ids: readonly string[]) => ids.some((id) => control.isProcessAlive?.(id) ?? false),
    };
    return sendConditional(request, reply, readAgentHistory(projectsDir(ctx), keys, chatId, probe));
  });

  // Ход главного агента любой сессии — тем же видом, что ход субагента; файл целиком.
  app.get<{ Params: { chatId: string }; Querystring: WindowQuery }>(
    '/api/chat/:chatId/main-agent',
    (request, reply) => {
      const transcript = readMainAgent(
        projectsDir(ctx),
        request.params.chatId,
        stepWindow(request.query),
      );
      if (!transcript) {
        return reply
          .code(404)
          .send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' });
      }
      return transcript;
    },
  );
}
