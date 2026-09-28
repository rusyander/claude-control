import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SessionLocation, SessionStopResult } from '@agentdeck/contracts';
import { sessionStopBodySchema } from '@agentdeck/contracts/request-bodies';
import type { ServerContext } from '../context.ts';
import {
  listCliProcesses,
  locateSession,
  panelAncestors,
  stopSessionProcess,
  transcriptIsWriting,
  type PanelRunView,
} from '../domains/analytics/session-process.ts';
import { findTranscript } from '../domains/chat/ChatTranscriptFile.ts';
import { findSessionCwd } from '../domains/chat/ChatHistory.ts';
import { parseBody } from '../lib/request-body.ts';

/**
 * «Перейти» и «Остановить» у строки вкладки «Сессии» аналитики.
 *
 * Прогоны чата панели знает реестр — ему и отвечать за них (стоп чата идёт
 * обычным `/api/chat/:chatId/stop`). Здесь — всё остальное: процесс CLI вне
 * панели, опознанный по номеру сессии в командной строке, и его снятие деревом
 * с проверкой, что под номером всё ещё он.
 */
export function registerAnalyticsSessionRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  runs: { active(): readonly PanelRunView[] },
): void {
  const projectsDir = () => join(ctx.location.paths.root, 'projects');

  app.get<{ Params: { sessionId: string } }>(
    '/api/analytics/sessions/:sessionId/where',
    async (request, reply): Promise<SessionLocation | typeof reply> => {
      const { sessionId } = request.params;
      const transcript = findTranscript(projectsDir(), sessionId);
      const [processes, ancestors] = await Promise.all([listCliProcesses(), panelAncestors()]);
      const where = locateSession(sessionId, {
        panelRuns: runs.active(),
        processes: processes ?? [],
        panelAncestors: ancestors,
        isWriting: transcriptIsWriting(transcript),
      });
      // Список процессов не получен (таймаут CIM/`ps`), а прогона панели нет —
      // где идёт сессия, сейчас не проверить. Пустой список назвал бы идущую в
      // терминале сессию «уже не идёт», и «Перейти» открыл бы её разговор вторым
      // писателем в тот же транскрипт (F-145b). Прогон панели список не нужен.
      if (!processes && where.kind !== 'panel') {
        return reply.code(503).send({
          message:
            'Не удалось получить список процессов — где идёт сессия, сейчас не проверить. Попробуйте ещё раз.',
          messageCode: 'session-processes-unavailable',
        });
      }
      const projectPath = transcript ? findSessionCwd(projectsDir(), sessionId) : undefined;
      return { sessionId, ...(projectPath ? { projectPath } : {}), where };
    },
  );

  app.post<{ Params: { sessionId: string }; Body: unknown }>(
    '/api/analytics/sessions/:sessionId/stop',
    async (request, reply): Promise<SessionStopResult | typeof reply> => {
      const body = parseBody(sessionStopBodySchema, request.body, reply);
      if (body === undefined) return reply;
      return stopSessionProcess(request.params.sessionId, body);
    },
  );
}
