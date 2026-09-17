import { fileURLToPath } from 'node:url';
import type { AppStore } from '../../lib/app-store.ts';
import { applyEntityState, type EntityToggleDeps } from '../entity-toggle.ts';
import type { ProviderMcpSettingsSource } from '../provider-mcp/types.ts';
import {
  bridgeRefusalReason,
  bridgeScriptExists,
  isPanelBridgeRegistered,
  registerPanelBridge,
  registeredBridgeId,
  unregisterPanelBridge,
  type PanelBridge,
  type PanelBridgeTarget,
} from '../panel-mcp.ts';
import { IntegrationError } from './errors.ts';
import { linkForCwd } from './links.ts';
import { BRAND_SLUG, LEGACY_BRAND_SLUG } from '../../lib/brand.mjs';

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
export const ATLASSIAN_MCP_ID = `${BRAND_SLUG}-atlassian`;

/** Путь к скрипту переходника: он лежит в самом репозитории панели. */
export function atlassianMcpScript(): string {
  return fileURLToPath(new URL('../../../../../tools/mcp/atlassian.mjs', import.meta.url));
}

/** Куда и чем писать запись — общее правило обоих переходников панели. */
function bridge(): PanelBridge {
  return {
    id: ATLASSIAN_MCP_ID,
    legacyId: `${LEGACY_BRAND_SLUG}-atlassian`,
    script: atlassianMcpScript(),
  };
}

export type McpRegistration = PanelBridgeTarget;

/**
 * Завести (или обновить) запись о переходнике.
 *
 * Обновление по тому же имени, а не отказ 409: кнопку жмут повторно после
 * переезда панели на другой порт, и «уже есть» было бы отказом чинить именно то,
 * что человек чинит.
 */
export function registerAtlassianMcp(options: McpRegistration): string {
  const self = bridge();
  if (!bridgeScriptExists(self)) {
    throw new IntegrationError(
      'integration_not_found',
      'Не найден скрипт переходника tools/mcp/atlassian.mjs — панель запущена не из своего репозитория.',
    );
  }
  // Активному CLI без раздела MCP запись не достаётся вовсе: без этой проверки
  // она уходила в конфигурацию Claude Code, панель рапортовала успех, а CLI,
  // которым человек работает, никакого инструмента не получал.
  const refusal = bridgeRefusalReason(options.store);
  if (refusal) throw new IntegrationError('invalid_body', refusal);
  return registerPanelBridge(self, options);
}

/** Убрать запись. Нет её — не ошибка: кнопку могли нажать дважды. */
export function unregisterAtlassianMcp(options: McpRegistration): boolean {
  return unregisterPanelBridge(bridge(), options);
}

/**
 * Зарегистрирован ли переходник — по нему рисуется кнопка «Подключить/Убрать».
 *
 * Спрашивается о ТОМ ЖЕ файле, в который пишет регистрация: у активного
 * провайдера — о его конфиге, у Claude — о `~/.claude.json`. Иначе кнопка
 * говорила бы о чужой конфигурации.
 */
export function isAtlassianMcpRegistered(
  mcpConfigPath: string,
  store?: ProviderMcpSettingsSource,
): boolean {
  return isPanelBridgeRegistered(bridge(), mcpConfigPath, store);
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
    // Запись могла остаться под прежним именем продукта — включаем ту, что есть.
    const id = registeredBridgeId(bridge(), deps.paths.mcpConfig);
    if (!id) return false;

    // Уже включённый сервер не пишется никуда: `setMcpServerEnabled` молча
    // возвращает `undefined`, когда запись и так в нужной секции, — поэтому
    // вызов на каждом старте прогона ничего не стоит.
    const moved = applyEntityState(deps, 'mcp', id, true).backupPath !== undefined;
    const wasMarked = store.isDisabled('mcp', id);
    if (wasMarked) store.setEnabled('mcp', id, true);
    return moved || wasMarked;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
