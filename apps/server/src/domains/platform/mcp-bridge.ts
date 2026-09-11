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
import { PlatformError } from './errors.ts';

/**
 * Переходник к контуру для АГЕНТА: то же окно наружу, что у человека в разделе
 * «Контур», но инструментами MCP.
 *
 * КЛЮЧ КОНТУРА В ПРОЦЕСС CLI НЕ ПОПАДАЕТ. Переходник (`tools/mcp/platform.mjs`)
 * не знает ни адреса контура, ни ключа — он ходит в панель по её локальному
 * адресу, а наружу ходит уже она. В записи конфигурации лежит ровно одна
 * переменная — `AGENTDECK_URL`.
 *
 * Регистрация — действие ЧЕЛОВЕКА (кнопка), никогда не автоматическое: запись
 * меняет конфигурацию его CLI, и делать это молча нельзя. Автоматического
 * включения, как у переходника Atlassian, здесь НЕТ: у контура нет привязки к
 * проекту, по которой можно было бы решить «этому прогону он нужен».
 */

/**
 * Имя записи. С префиксом панели: «contour» или «enterprise-platform» — вероятные имена
 * чужих серверов, и совпадение означало бы запись поверх чужой настройки.
 */
export const PLATFORM_MCP_ID = 'agentdeck-contour';

/** Путь к скрипту переходника: он лежит в самом репозитории панели. */
export function platformMcpScript(): string {
  return fileURLToPath(new URL('../../../../../tools/mcp/platform.mjs', import.meta.url));
}

function bridge(): PanelBridge {
  return { id: PLATFORM_MCP_ID, script: platformMcpScript() };
}

/** Завести или обновить запись. Повторное нажатие обновляет адрес панели. */
export function registerPlatformMcp(options: PanelBridgeTarget): string {
  const self = bridge();
  if (!bridgeScriptExists(self)) {
    throw new PlatformError(
      'platform_not_found',
      'Не найден скрипт переходника tools/mcp/platform.mjs — панель запущена не из своего репозитория.',
    );
  }
  // Активному CLI без раздела MCP запись не достаётся вовсе: молчаливая запись
  // в чужой файл выглядела бы успехом, а инструмента у человека не появлялось бы.
  const refusal = bridgeRefusalReason(options.store);
  if (refusal) throw new PlatformError('invalid_body', refusal);
  return registerPanelBridge(self, options);
}

/** Почему переходник записать некуда — для кнопки, которая обязана сказать причину. */
export function platformMcpRefusal(store?: ProviderMcpSettingsSource): string | undefined {
  return bridgeRefusalReason(store);
}

/** Убрать запись. Нет её — не ошибка: кнопку могли нажать дважды. */
export function unregisterPlatformMcp(options: PanelBridgeTarget): boolean {
  return unregisterPanelBridge(bridge(), options);
}

export function isPlatformMcpRegistered(
  mcpConfigPath: string,
  store?: ProviderMcpSettingsSource,
): boolean {
  return isPanelBridgeRegistered(bridge(), mcpConfigPath, store);
}
