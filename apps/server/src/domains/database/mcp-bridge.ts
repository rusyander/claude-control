import { fileURLToPath } from 'node:url';
import type { ProviderMcpSettingsSource } from '../provider-mcp/types.ts';
import {
  bridgeRefusalReason,
  bridgeScriptExists,
  isPanelBridgeRegistered,
  registerPanelBridge,
  unregisterPanelBridge,
  type PanelBridge,
  type PanelBridgeTarget,
} from '../panel-mcp.ts';
import { BRAND_SLUG } from '../../lib/brand.mjs';

/**
 * База проекта глазами АГЕНТА: переходник MCP `tools/mcp/database.mjs`. Он не
 * второй клиент Postgres, а тонкая обёртка над API панели — тем же маршрутам,
 * что у вкладки «База данных». Поэтому у агента те же пределы, что у человека:
 * только чтение, сторож запроса, транзакция READ ONLY, — и ни пароль, ни адрес
 * базы в процесс CLI не попадают. В окружение записи уходит только адрес панели.
 *
 * Регистрация — действие человека кнопкой: запись меняет конфигурацию CLI.
 */

export const DATABASE_MCP_ID = `${BRAND_SLUG}-database`;

export function databaseMcpScript(): string {
  return fileURLToPath(new URL('../../../../../tools/mcp/database.mjs', import.meta.url));
}

const bridge = (): PanelBridge => ({ id: DATABASE_MCP_ID, script: databaseMcpScript() });

export class DatabaseBridgeError extends Error {
  readonly code: 'db-mcp-script-missing' | 'db-mcp-unsupported';

  constructor(code: DatabaseBridgeError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function registerDatabaseMcp(options: PanelBridgeTarget): string {
  const self = bridge();
  if (!bridgeScriptExists(self)) {
    throw new DatabaseBridgeError(
      'db-mcp-script-missing',
      'Не найден скрипт переходника tools/mcp/database.mjs — панель запущена не из своего репозитория.',
    );
  }
  const refusal = bridgeRefusalReason(options.store);
  if (refusal) throw new DatabaseBridgeError('db-mcp-unsupported', refusal);
  return registerPanelBridge(self, options);
}

export function unregisterDatabaseMcp(options: PanelBridgeTarget): boolean {
  return unregisterPanelBridge(bridge(), options);
}

export function isDatabaseMcpRegistered(
  mcpConfigPath: string,
  store?: ProviderMcpSettingsSource,
): boolean {
  return isPanelBridgeRegistered(bridge(), mcpConfigPath, store);
}
