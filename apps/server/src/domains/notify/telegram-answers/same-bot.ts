import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from '../../../lib/safe-io/safe-io.ts';
import { readEnvLookup } from '../../env/env.ts';
import { readLaunch, type RawServer, type VarLookup } from '../../integrations/discover/launch.ts';
import { botIdOf } from './bot-api.ts';

/**
 * Бот агента: MCP-сервер Telegram (запись в `~/.claude.json`, `.mcp.json`
 * проекта) или канал-плагин Claude Code (`channels/telegram/.env`). Он сам
 * слушает `getUpdates` — второй слушатель того же бота отнимал бы у него
 * сообщения, а Telegram отвечал бы обоим 409. Поэтому ответы из Telegram
 * обязаны идти через другого бота.
 *
 * Наружу — только номера ботов (часть токена до двоеточия); сами токены этот
 * модуль не отдаёт.
 */

export interface AgentBotPaths {
  /** `~/.claude.json`. */
  mcpConfig: string;
  settings: string;
  settingsLocal: string;
  secretsEnv: string;
  /** Каталог конфигурации (`~/.claude`) — там живёт канал-плагин Telegram. */
  configRoot: string;
}

const TOKEN_NAME = 'TELEGRAM_BOT_TOKEN';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serversOf(block: unknown): RawServer[] {
  return isRecord(block) ? Object.values(block).filter(isRecord) : [];
}

function looksTelegram(raw: RawServer): boolean {
  return /telegram/i.test(JSON.stringify([raw.command, raw.args, raw.url]));
}

function channelToken(configRoot: string): string | undefined {
  const file = join(configRoot, 'channels', 'telegram', '.env');
  if (!existsSync(file)) return undefined;
  try {
    const match = new RegExp(`^${TOKEN_NAME}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Номера ботов, которых слушает агент. */
export function agentBotIds(paths: AgentBotPaths, projects: readonly string[]): Set<string> {
  const lookup = readEnvLookup(paths.settings, paths.secretsEnv, paths.settingsLocal);
  const inherited: VarLookup = (name) => lookup[name] ?? process.env[name];
  const config = readJsonFile<Record<string, unknown>>(paths.mcpConfig, {});
  const servers: RawServer[] = [
    ...serversOf(config.mcpServers),
    ...serversOf(config.mcpServersDisabled),
  ];
  const projectPaths = new Set(projects);
  if (isRecord(config.projects)) {
    for (const [project, value] of Object.entries(config.projects)) {
      projectPaths.add(project);
      if (isRecord(value)) servers.push(...serversOf(value.mcpServers));
    }
  }
  for (const project of projectPaths) {
    const file = join(project, '.mcp.json');
    if (!existsSync(file)) continue;
    servers.push(...serversOf(readJsonFile<Record<string, unknown>>(file, {}).mcpServers));
  }
  const ids = new Set<string>();
  const add = (token: string | undefined): void => {
    const id = botIdOf(token);
    if (id) ids.add(id);
  };
  for (const raw of servers) {
    const launched = readLaunch(raw, inherited);
    const explicit = launched.explicit(TOKEN_NAME);
    // Сервер Telegram без своего значения берёт его из окружения запуска.
    add(explicit ?? (looksTelegram(raw) ? inherited(TOKEN_NAME) : undefined));
  }
  add(channelToken(paths.configRoot));
  return ids;
}
