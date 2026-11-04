import { fileURLToPath } from 'node:url';
import { PANEL_BRIDGE_SERVER } from '@agentdeck/contracts/core/ask';
import type { McpServerEntry } from '../../adapters/adapter.types.ts';

/**
 * Мост инструментов панели в сессии «ask» (этап 10, F2): ЕДИНСТВЕННЫЙ сервер MCP, который ядро
 * добавляет по просьбе панели, — и тот известен ядру заранее. Путь к скрипту ядро находит само
 * (корень репозитория от этого модуля), команда — node ядра: ни команды, ни своего сервера
 * вызывающий не передаёт. В окружение моста идут только адрес панели и токен этой сессии;
 * токен берётся из книги в памяти (`AskBridgeBook`) и отмечается маской `known`.
 */

/** `tools/mcp/panel.mjs` от `apps/core/src/bootstrap/session-road/`: пять уровней вверх — корень. */
export const PANEL_BRIDGE_SCRIPT = fileURLToPath(
  new URL('../../../../../tools/mcp/panel.mjs', import.meta.url),
);

/** Имя переменной токена моста: `panel.mjs` читает её вместо файла токена панели. */
export const BRIDGE_TOKEN_VAR = 'AGENTDECK_BRIDGE_TOKEN';
export const BRIDGE_URL_VAR = 'AGENTDECK_URL';

export interface PanelBridgeAsk {
  url: string;
  conversation?: string;
}

/**
 * Запись `mcpServers` моста: `[имя, запись]`. Токена нет — отказ с причиной: сессия без моста
 * не идёт молча (книга потеряна перезапуском ядра, или задача уже кончилась).
 */
export function panelBridgeEntry(
  nodeArgv: readonly string[],
  bridge: PanelBridgeAsk,
  token: string | undefined,
  script: string = PANEL_BRIDGE_SCRIPT,
): { ok: true; name: string; entry: McpServerEntry } | { ok: false; reason: string } {
  if (!token) {
    return {
      ok: false,
      reason: 'panel-bridge token unknown: the core lost it (restart) or the task already ended',
    };
  }
  // Флаги снятия типов node ядра мосту не нужны: `panel.mjs` — чистый ESM.
  const [command = process.execPath] = nodeArgv;
  return {
    ok: true,
    name: PANEL_BRIDGE_SERVER,
    entry: {
      command,
      args: [script, ...(bridge.conversation ? ['--conversation', bridge.conversation] : [])],
      env: { [BRIDGE_URL_VAR]: bridge.url, [BRIDGE_TOKEN_VAR]: token },
    },
  };
}
