import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AppStore } from '../../lib/app-store.ts';
import { applyEntityState, type EntityToggleDeps } from '../entity-toggle.ts';
import {
  McpServerNotFoundError,
  assertMcpServerExists,
  deleteMcpServer,
  saveMcpServer,
} from '../mcp.ts';
import { IntegrationError } from './errors.ts';
import { linkForCwd } from './links.ts';

/**
 * Собственный MCP-сервер панели: то же самое окно наружу, но для АГЕНТА.
 *
 * Человек ходит в Jira и Confluence через интерфейс панели, а агент — через
 * этот сервер, и оба идут одним кодом: сервер не второй клиент Atlassian, а
 * тонкий переходник к API самой панели (`tools/mcp/atlassian.mjs`). Отсюда
 * главное свойство: ТОКЕН ATLASSIAN НЕ ПОПАДАЕТ В ПРОЦЕСС CLI ВООБЩЕ. В
 * окружение записи уходит только адрес панели.
 *
 * Регистрация — действие ЧЕЛОВЕКА (кнопка), никогда не автоматическое: запись в
 * `~/.claude.json` меняет конфигурацию Claude Code, и делать это молча нельзя.
 * А вот ВКЛЮЧЕНИЕ уже зарегистрированного — автоматическое, как у групп
 * (`domains/group-activation.ts`): прогон в проекте с привязкой включает сервер
 * и НИКОГДА ничего не выключает.
 */

/**
 * Имя записи в конфиге. С префиксом панели намеренно: «atlassian» — самое
 * вероятное имя ОФИЦИАЛЬНОГО сервера Atlassian, и совпадение имён означало бы
 * либо 409 на ровном месте, либо запись поверх чужой настройки.
 */
export const ATLASSIAN_MCP_ID = 'agentdeck-atlassian';

/** Путь к скрипту переходника: он лежит в самом репозитории панели. */
export function atlassianMcpScript(): string {
  return fileURLToPath(new URL('../../../../../tools/mcp/atlassian.mjs', import.meta.url));
}

export interface McpRegistration {
  mcpConfigPath: string;
  backupDir?: string;
  /** Адрес самой панели: `http://127.0.0.1:5178`. */
  selfBaseUrl: string;
}

/**
 * Завести (или обновить) запись о переходнике.
 *
 * Обновление по тому же имени, а не отказ 409: кнопку жмут повторно после
 * переезда панели на другой порт, и «уже есть» было бы отказом чинить именно то,
 * что человек чинит.
 */
export function registerAtlassianMcp(options: McpRegistration): string {
  const script = atlassianMcpScript();
  if (!existsSync(script)) {
    throw new IntegrationError(
      'integration_not_found',
      'Не найден скрипт переходника tools/mcp/atlassian.mjs — панель запущена не из своего репозитория.',
    );
  }

  const draft = {
    name: ATLASSIAN_MCP_ID,
    transport: 'stdio' as const,
    // Тем же Node, которым работает сама панель: искать `node` в PATH незачем,
    // а на Windows это ещё и разные `node.exe` у разных менеджеров версий.
    command: process.execPath,
    args: [script],
    // ТОЛЬКО адрес. Токен Atlassian сюда не попадает ни при каких условиях —
    // переходник ходит в панель, а к Atlassian ходит уже она.
    env: { AGENTDECK_URL: options.selfBaseUrl },
    headers: {},
    groupIds: [],
  };

  saveMcpServer(options.mcpConfigPath, existing(options.mcpConfigPath), draft, options.backupDir, {
    allowOverwrite: true,
  });
  return ATLASSIAN_MCP_ID;
}

/** Убрать запись. Нет её — не ошибка: кнопку могли нажать дважды. */
export function unregisterAtlassianMcp(options: McpRegistration): boolean {
  try {
    deleteMcpServer(options.mcpConfigPath, ATLASSIAN_MCP_ID, options.backupDir);
    return true;
  } catch (error) {
    if (error instanceof McpServerNotFoundError) return false;
    throw error;
  }
}

/** Зарегистрирован ли переходник — по нему рисуется кнопка «Подключить/Убрать». */
export function isAtlassianMcpRegistered(mcpConfigPath: string): boolean {
  return existing(mcpConfigPath) !== null;
}

function existing(mcpConfigPath: string): string | null {
  try {
    assertMcpServerExists(mcpConfigPath, ATLASSIAN_MCP_ID);
    return ATLASSIAN_MCP_ID;
  } catch {
    return null;
  }
}

/**
 * Включить переходник, если прогон идёт в проекте с привязкой.
 *
 * Зеркало `activateGroupsForCwd`: включаем и НИКОГДА не выключаем. Выключение по
 * выходу из проекта било бы по чужому живому агенту, который работает в другой
 * копии ветки того же репозитория, и виноватого он бы не нашёл.
 *
 * Осечка не имеет права ронять прогон — интеграция не главнее работы.
 */
export function activateAtlassianMcp(
  deps: EntityToggleDeps,
  store: AppStore,
  cwd: string,
  onError?: (error: unknown) => void,
): boolean {
  try {
    if (!cwd || !linkForCwd(store, cwd)) return false;
    if (!isAtlassianMcpRegistered(deps.paths.mcpConfig)) return false;

    // Уже включённый сервер не пишется никуда: `setMcpServerEnabled` молча
    // возвращает `undefined`, когда запись и так в нужной секции, — поэтому
    // вызов на каждом старте прогона ничего не стоит.
    const moved = applyEntityState(deps, 'mcp', ATLASSIAN_MCP_ID, true).backupPath !== undefined;
    const wasMarked = store.isDisabled('mcp', ATLASSIAN_MCP_ID);
    if (wasMarked) store.setEnabled('mcp', ATLASSIAN_MCP_ID, true);
    return moved || wasMarked;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
