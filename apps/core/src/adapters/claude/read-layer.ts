import { join } from 'node:path';
import type { ReadLayer } from '../adapter.types.ts';
import { claudeGlobalConfigFiles } from './trust.ts';
import { claudeConfigDir } from './user-layer.ts';

/**
 * Что модель Claude Code читает в слое человека (F-87): каталоги навыков, правил, агентов, команд
 * и плагинов в каталоге конфигурации — ссылки навыков открываются оттуда. Учётные данные —
 * `.credentials.json` (токен входа), `settings.json` (ключи в `env`) и глобальный конфиг CLI
 * (`.claude.json` / старый `.config.json`: `primaryApiKey`, `env` серверов MCP). Имена — здесь (P108).
 */

const LAYER_DIRS = ['skills', 'rules', 'agents', 'commands', 'plugins'] as const;
const CREDENTIALS = ['.credentials.json', 'settings.json'] as const;

export function claudeReadLayer(pin: Record<string, string>): ReadLayer {
  const config = claudeConfigDir(pin);
  const global = claudeGlobalConfigFiles(pin);
  return {
    dirs: LAYER_DIRS.map((name) => join(config, name)),
    credentials: [...CREDENTIALS.map((name) => join(config, name)), global.main, global.legacy],
    // Сам CLI пишет глобальный конфиг на каждом запуске, обновляет токен входа и ведёт каталог
    // плагинов (кэш, магазины, данные плагинов) — это не эффект шага.
    volatile: [global.main, join(config, '.credentials.json'), join(config, 'plugins')],
  };
}
