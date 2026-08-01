import type { FastifyInstance } from 'fastify';
import type {
  ProviderCompareResponse,
  ProviderMigrateRequest,
  ProviderMigrateResponse,
  UniversalMcpServer,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { isKnownProviderId } from '../providers/registry.ts';
import {
  compareProviders,
  migrateProvider,
  CompareRequestError,
  type ClaudeSide,
} from '../domains/provider-compare.ts';
import { readMcpServers, saveMcpServer } from '../domains/mcp.ts';
import { readEnvVars } from '../domains/env.ts';
import { readPermissions } from '../domains/permissions.ts';
import { UnrecognizedFormatError } from '../lib/format-errors.ts';

/**
 * Сравнение конфигураций двух провайдеров и перенос записей между ними
 * (IDEA-5 + IDEA-4).
 *
 * `GET /api/provider-compare?left&right` — только чтение, ничего не меняет.
 * `POST /api/provider-migrate` — по умолчанию считает предпросмотр; настоящая
 * запись идёт только при `mode: 'apply'`, то есть отдельным явным действием.
 *
 * Незнакомый id — 400, а не молчаливый откат на claude: откат означал бы
 * «сравнили не то, что просили», а при переносе — запись не туда.
 */
export function registerProviderCompareRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const claudeSide = (): ClaudeSide => ({
    mcpConfigPath: ctx.location.paths.mcpConfig,
    claudeMdPath: ctx.location.paths.claudeMd,
    readMcp: () => readMcpServers(ctx.location.paths.mcpConfig, ctx.store),
    readEnv: () =>
      readEnvVars(
        ctx.location.paths.settings,
        ctx.location.paths.secretsEnv,
        ctx.location.paths.settingsLocal,
      ),
    readPermissions: () =>
      readPermissions(ctx.location.paths.settings, ctx.store, ctx.location.paths.settingsLocal),
    writeMcp: (filePath: string, server: UniversalMcpServer, backupDir: string | undefined) => {
      saveMcpServer(
        filePath,
        null,
        {
          name: server.name,
          transport: server.transport,
          command: server.command,
          args: server.args,
          url: server.url,
          env: server.env,
          headers: server.headers,
          groupIds: [],
        },
        backupDir,
        // Перенос конфигурации — осознанная замена: пользователь уже видел
        // предпросмотр и подтвердил его. Отказ по занятому имени здесь означал бы,
        // что повторный перенос падает на каждом уже перенесённом сервере.
        { allowOverwrite: true },
      );
    },
  });

  app.get<{ Querystring: { left?: string; right?: string } }>(
    '/api/provider-compare',
    (request, reply) => {
      const left = request.query.left ?? '';
      const right = request.query.right ?? '';

      if (!isKnownProviderId(left) || !isKnownProviderId(right)) {
        return reply
          .code(400)
          .send({ error: 'unknown_provider', message: 'Такого провайдера панель не знает.' });
      }

      try {
        return compareProviders(left, right, {
          claudeDirOverride: ctx.store.getSettings().claudeDirOverride,
          claude: claudeSide(),
        }) satisfies ProviderCompareResponse;
      } catch (error) {
        if (error instanceof CompareRequestError) {
          return reply.code(400).send({ error: 'bad_request', message: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Body: ProviderMigrateRequest }>('/api/provider-migrate', (request, reply) => {
    const body = request.body;

    if (!isKnownProviderId(body?.from ?? '') || !isKnownProviderId(body?.to ?? '')) {
      return reply
        .code(400)
        .send({ error: 'unknown_provider', message: 'Такого провайдера панель не знает.' });
    }

    try {
      return migrateProvider(body, {
        claudeDirOverride: ctx.store.getSettings().claudeDirOverride,
        claude: claudeSide(),
        // Копии делаются только при настоящей записи: предпросмотр не должен
        // вытеснять историю из ротации.
        backupDir: ctx.store.getSettings().backupBeforeWrite
          ? ctx.location.paths.appData
          : undefined,
      }) satisfies ProviderMigrateResponse;
    } catch (error) {
      if (error instanceof CompareRequestError) {
        return reply.code(400).send({ error: 'bad_request', message: error.message });
      }
      if (error instanceof UnrecognizedFormatError) {
        return reply.code(422).send({
          error: 'format_unrecognized',
          message: 'Формат файла приёмника не распознан — панель в него не пишет.',
        });
      }
      throw error;
    }
  });
}
