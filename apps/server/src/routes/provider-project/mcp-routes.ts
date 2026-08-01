import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readProviderMcpSection,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
  parseUniversalDraft,
  McpServerExistsError,
} from '../../domains/provider-mcp.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';
import { done } from '../write-result.ts';
import { requireTarget } from './target.ts';
import { FORMAT_UNRECOGNIZED, INVALID_DRAFT, MCP_UNSUPPORTED } from './messages.ts';

/** MCP-серверы проекта: тот же универсальный субсет, что и глобально, файл в проекте. */
export function registerProviderProjectMcpRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/mcp', (request, reply) => {
    const target = requireTarget(ctx, request.params.id, reply);
    if (!target) return reply;
    if (!target.mcp) return reply.code(400).send(MCP_UNSUPPORTED);

    const base = {
      providerId: target.provider.id,
      providerName: target.provider.name,
      format: target.mcp.format,
      filePath: target.mcp.filePath,
      cliDetected: target.mcp.cliDetected,
      blockDir: target.mcp.blockDir,
    };

    try {
      // Файлы-блоки проекта (Continue: `<проект>/.continue/mcpServers/*.yaml`)
      // читаются тем же кодом, что и глобальные, — раздел один и тот же.
      const section = readProviderMcpSection(target.mcp);
      return {
        ...base,
        servers: section.servers,
        skippedBlocks: section.skippedBlocks,
        readOnly: false,
      };
    } catch (error) {
      // Формат не распознан — отдаём раздел на чтение (пустой список) с пометкой.
      if (error instanceof UnrecognizedFormatError) {
        return { ...base, servers: [], skippedBlocks: [], readOnly: true, error: error.message };
      }
      throw error;
    }
  });

  /** Общая обёртка записи MCP: fail-closed на нераспознанном формате файла. */
  const writeMcp = (reply: FastifyReply, run: () => string | undefined): unknown => {
    try {
      return done(run());
    } catch (error) {
      // Имя занято (создание или переименование) — конфликт, а не запись поверх:
      // проектный конфиг такой же чужой файл, что и глобальный.
      if (error instanceof McpServerExistsError) {
        return reply.code(409).send({ error: 'server_exists', message: error.message });
      }
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      throw error;
    }
  };

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/mcp',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const mcp = target.mcp;
      if (!mcp) return reply.code(400).send(MCP_UNSUPPORTED);

      const draft = parseUniversalDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_DRAFT);

      return writeMcp(reply, () => upsertProviderMcpServer(mcp, null, draft, ctx.backupDir));
    },
  );

  app.put<{ Params: { id: string; serverId: string }; Body: unknown }>(
    '/api/projects/:id/provider/mcp/:serverId',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const mcp = target.mcp;
      if (!mcp) return reply.code(400).send(MCP_UNSUPPORTED);

      const draft = parseUniversalDraft(request.body);
      if (!draft) return reply.code(400).send(INVALID_DRAFT);

      return writeMcp(reply, () =>
        upsertProviderMcpServer(mcp, request.params.serverId, draft, ctx.backupDir),
      );
    },
  );

  app.delete<{ Params: { id: string; serverId: string } }>(
    '/api/projects/:id/provider/mcp/:serverId',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      const mcp = target.mcp;
      if (!mcp) return reply.code(400).send(MCP_UNSUPPORTED);

      return writeMcp(reply, () =>
        deleteProviderMcpServer(mcp, request.params.serverId, ctx.backupDir),
      );
    },
  );
}
