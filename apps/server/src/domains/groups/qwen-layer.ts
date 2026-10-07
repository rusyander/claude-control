import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { scopeProvider } from '@agentdeck/contracts/group-sources';
import { readJsonFile } from '../../lib/safe-io.ts';

/**
 * Общие части слоя Qwen: файл системных настроек, куда кладутся слои, перевод
 * записи MCP. Сам слой групп на прогон — `qwen-run-layer.ts` (писатель реестра
 * `run-layer.ts`); файл системных настроек этого же механизма собирает и
 * проверка прав прогона тестов (`project-tests/agent/foreign-gate.ts`).
 *
 * Механизм: `QWEN_CODE_SYSTEM_SETTINGS_PATH` указывает на файл системных
 * настроек, который Qwen сливает с пользовательскими. Проверено живьём на
 * qwen-code 0.25.0 (provider-formats, «Qwen group layer»).
 */

export const QWEN_SYSTEM_SETTINGS_ENV = 'QWEN_CODE_SYSTEM_SETTINGS_PATH';

/** Куда класть слои: каталог на отпечаток содержимого, старые подчищаются. */
export function qwenLayersRoot(appData: string): string {
  return join(appData, 'qwen-group-layers');
}

/** Где Qwen ищет системные настройки, если переменная не задана (как в самом CLI). */
export function defaultQwenSystemSettingsPath(os: string = platform()): string {
  if (os === 'darwin') return '/Library/Application Support/QwenCode/settings.json';
  if (os === 'win32') return 'C:\\ProgramData\\qwen-code\\settings.json';
  return '/etc/qwen-code/settings.json';
}

/** Нужна ли группе подача слоем: её файлы лежат в каталогах Claude. */
export function needsQwenLayer(group: Pick<Group, 'scope'>): boolean {
  return scopeProvider(group.scope) === 'claude';
}

/** Запись MCP Claude → запись Qwen; форма, которую панель не знает, — `undefined`. */
export function qwenMcpEntry(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const type = entry.type ?? (typeof entry.command === 'string' ? 'stdio' : undefined);
  const headers = entry.headers && typeof entry.headers === 'object' ? entry.headers : undefined;
  if (type === 'stdio' && typeof entry.command === 'string') {
    return {
      command: entry.command,
      ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
      ...(entry.env && typeof entry.env === 'object' ? { env: entry.env } : {}),
    };
  }
  // У Qwen стримируемый HTTP — `httpUrl`, SSE — `url` (как у gemini).
  if (type === 'http' && typeof entry.url === 'string') {
    return { httpUrl: entry.url, ...(headers ? { headers } : {}) };
  }
  if (type === 'sse' && typeof entry.url === 'string') {
    return { url: entry.url, ...(headers ? { headers } : {}) };
  }
  return undefined;
}

/**
 * Системные настройки, поверх которых ложится слой: их отбрасывать нельзя.
 * Тот же источник берёт и проверка прав прогона тестов (`project-tests/agent/
 * foreign-gate.ts`): два писателя одного файла настроек разошлись бы.
 */
export function baseSystemSettings(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = env[QWEN_SYSTEM_SETTINGS_ENV] || defaultQwenSystemSettingsPath();
  const base = existsSync(path) ? readJsonFile<unknown>(path, {}) : {};
  return base && typeof base === 'object' && !Array.isArray(base)
    ? (base as Record<string, unknown>)
    : {};
}
