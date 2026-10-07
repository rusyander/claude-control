import type { FastifyInstance } from 'fastify';
import type { CliInfo, CliUpdateResult } from '@agentdeck/contracts';
import { claudeProvider } from '../../providers/claude.ts';
import { providerCliCandidates, providerCliCommand } from '../../providers/cli.ts';
import { readCliInfo, updateCli, type CliExec } from '../../providers/cli-install.ts';
import {
  getActiveProvider,
  getProvider,
  isKnownProviderId,
  type SettingsSource,
} from '../../providers/registry.ts';
import type { ConfigProvider } from '../../providers/types.ts';

/**
 * Подкоманда самообновления CLI — только там, где она проверена на самом CLI
 * (`.agent/provider-formats.agent.md`): `claude update`, `qwen update` (0.25.0,
 * «Check for Qwen Code updates and install if available»), `codex update`
 * (0.160, «Update Codex to the latest version»), `goose update` (1.53.0, «Update
 * the goose CLI version»; без `--reconfigure` ничего не спрашивает), `kimi update -y`
 * (Kimi Code 2.1.1: без `-y` ждёт подтверждения, а панель запускает CLI без
 * терминала — запуск висел бы до тайм-аута), `opencode upgrade` (1.18.34, другой
 * подкоманды обновления у opencode нет). У gemini/aider/continue подкоманда не
 * проверена — кнопки нет, запрос получает код отказа, а не запуск наугад.
 */
const UPDATE_ARGS: Readonly<Partial<Record<string, readonly string[]>>> = {
  claude: ['update'],
  qwen: ['update'],
  codex: ['update'],
  goose: ['update'],
  kimi: ['update', '-y'],
  opencode: ['upgrade'],
};

/**
 * CLI, которым идут чаты: путь, версия, копии новее (замечание живого прогона
 * 25.09.2026 — панель молча запускала старую копию из PATH) и обновление той
 * самой копии, которую панель запускает. Чей CLI — `?provider=<id>`, иначе
 * активного провайдера: под Qwen строка «Запускается…» про `claude` была бы
 * ответом не на тот вопрос.
 */
export function registerChatCliRoutes(
  app: FastifyInstance,
  /** Запуск процессов — подменяется в тестах; по умолчанию настоящий. */
  exec?: CliExec,
  /** Настройки панели (активный провайдер); нет — Claude, как было до выбора провайдера. */
  settings?: () => SettingsSource,
): void {
  const providerOf = (requested: unknown): ConfigProvider => {
    if (typeof requested === 'string' && isKnownProviderId(requested))
      return getProvider(requested);
    return settings ? getActiveProvider(settings()) : claudeProvider;
  };

  const info = (provider: ConfigProvider, refresh: boolean): CliInfo => ({
    ...readCliInfo(providerCliCommand(provider), providerCliCandidates(provider), {
      refresh,
      ...(exec ? { exec } : {}),
    }),
    providerId: provider.id,
    providerName: provider.name,
    canUpdate: UPDATE_ARGS[provider.id] !== undefined,
  });

  app.get<{ Querystring: { refresh?: string; provider?: string } }>('/api/chat/cli', (request) =>
    info(providerOf(request.query.provider), request.query.refresh === '1'),
  );

  app.post<{ Querystring: { provider?: string } }>(
    '/api/chat/cli/update',
    async (request, reply) => {
      const provider = providerOf(request.query.provider);
      const args = UPDATE_ARGS[provider.id];
      if (!args) {
        return reply.code(409).send({
          error: 'cli_update_unsupported',
          message: `Обновление CLI ${provider.name} из панели не поддерживается`,
          messageCode: 'cli-update-unsupported',
          messageParams: { provider: provider.name },
        });
      }
      const before = info(provider, true);
      if (!before.path) {
        return provider.id === 'claude'
          ? reply
              .code(404)
              .send({ message: 'CLI Claude не найден в PATH', messageCode: 'cli-not-found' })
          : reply.code(404).send({
              message: `CLI ${provider.name} не найден в PATH`,
              messageCode: 'cli-provider-not-found',
              messageParams: { provider: provider.name },
            });
      }
      const outcome = updateCli(before.path, { ...(exec ? { exec } : {}), args: [...args] });
      return { ...outcome, info: info(provider, true) } satisfies CliUpdateResult;
    },
  );
}
