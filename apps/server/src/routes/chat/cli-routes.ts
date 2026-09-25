import type { FastifyInstance } from 'fastify';
import type { CliInfo, CliUpdateResult } from '@agentdeck/contracts';
import { claudeProvider } from '../../providers/claude.ts';
import { providerCliCandidates, providerCliCommand } from '../../providers/cli.ts';
import { readCliInfo, updateCli, type CliExec } from '../../providers/cli-install.ts';

/**
 * CLI Claude, которым идут чаты: путь, версия, копии новее (замечание живого
 * прогона 25.09.2026 — панель молча запускала старую копию из PATH) и
 * обновление той самой копии, которую панель запускает.
 */
export function registerChatCliRoutes(
  app: FastifyInstance,
  /** Запуск процессов — подменяется в тестах; по умолчанию настоящий. */
  exec?: CliExec,
): void {
  const info = (refresh: boolean): CliInfo =>
    readCliInfo(providerCliCommand(claudeProvider), providerCliCandidates(claudeProvider), {
      refresh,
      ...(exec ? { exec } : {}),
    });

  app.get<{ Querystring: { refresh?: string } }>('/api/chat/cli', (request) =>
    info(request.query.refresh === '1'),
  );

  app.post('/api/chat/cli/update', async (_request, reply) => {
    const before = info(true);
    if (!before.path) {
      return reply
        .code(404)
        .send({ message: 'CLI Claude не найден в PATH', messageCode: 'cli-not-found' });
    }
    const outcome = updateCli(before.path, exec ? { exec } : {});
    return { ...outcome, info: info(true) } satisfies CliUpdateResult;
  });
}
