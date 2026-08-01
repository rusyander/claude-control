import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProviderMcpInfo } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderMcpTarget,
  readProviderMcpSection,
  upsertProviderMcpServer,
  deleteProviderMcpServer,
  parseUniversalDraft,
  McpServerExistsError,
  type ProviderMcpTarget,
} from '../domains/provider-mcp.ts';
import { UnrecognizedFormatError } from '../lib/format-errors.ts';
import { done } from './write-result.ts';

/**
 * Универсальный раздел MCP-серверов для провайдеров Gemini (JSON) и Codex (TOML).
 * Claude сюда НЕ ходит: его MCP на собственных богатых роутах `/api/mcp` — их не
 * трогаем. Клиент выбирает набор роутов по активному провайдеру.
 *
 * Fail-closed: провайдер без `mcp=ready`/`mcpConfig` → 400 `section_unsupported`
 * (Claude сюда тоже попадает под этот отказ — у него нет `mcpConfig`). Формат
 * файла не распознан → запись отвечает 422 `format_unrecognized`, чтение отдаёт
 * `readOnly:true`. Секреты (env/headers) в лог не пишем.
 */
export function registerProviderMcpRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера нет универсального раздела MCP.',
  } as const;

  const requireTarget = (reply: FastifyReply): ProviderMcpTarget | undefined => {
    const target = resolveProviderMcpTarget(ctx.store);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  app.get('/api/provider-mcp', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const base = {
      providerId: target.provider.id,
      providerName: target.provider.name,
      format: target.format,
      filePath: target.filePath,
      cliDetected: target.cliDetected,
      blockDir: target.blockDir,
    };

    try {
      const section = readProviderMcpSection(target);
      return {
        ...base,
        servers: section.servers,
        skippedBlocks: section.skippedBlocks,
        readOnly: false,
      } satisfies ProviderMcpInfo;
    } catch (error) {
      // Формат не распознан — отдаём раздел на чтение (пустой список) с пометкой.
      if (error instanceof UnrecognizedFormatError) {
        return {
          ...base,
          servers: [],
          skippedBlocks: [],
          readOnly: true,
          error: error.message,
        } satisfies ProviderMcpInfo;
      }
      throw error;
    }
  });

  const INVALID_DRAFT = {
    error: 'invalid_draft',
    message:
      'Черновик сервера не прошёл проверку: нужны имя, транспорт и команда (stdio) или адрес (http).',
  } as const;

  const FORMAT_UNRECOGNIZED = {
    error: 'format_unrecognized',
    message:
      'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
  } as const;

  app.post<{ Body: unknown }>('/api/provider-mcp', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const draft = parseUniversalDraft(request.body);
    if (!draft) return reply.code(400).send(INVALID_DRAFT);

    try {
      return done(upsertProviderMcpServer(target, null, draft, ctx.backupDir));
    } catch (error) {
      // Имя занято: молча писать поверх — потеря чужого сервера, поэтому
      // конфликт и решение остаётся за человеком (переименовать или открыть тот).
      if (error instanceof McpServerExistsError) {
        return reply.code(409).send({ error: 'server_exists', message: error.message });
      }
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      throw error;
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/provider-mcp/:id', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const draft = parseUniversalDraft(request.body);
    if (!draft) return reply.code(400).send(INVALID_DRAFT);

    try {
      return done(upsertProviderMcpServer(target, request.params.id, draft, ctx.backupDir));
    } catch (error) {
      // Переименование в занятое имя — тот же конфликт, что и создание.
      if (error instanceof McpServerExistsError) {
        return reply.code(409).send({ error: 'server_exists', message: error.message });
      }
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/provider-mcp/:id', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    try {
      return done(deleteProviderMcpServer(target, request.params.id, ctx.backupDir));
    } catch (error) {
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      throw error;
    }
  });
}
