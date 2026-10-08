import type { EnvItem } from '@agentdeck/contracts/portable-env';

/**
 * Выключена ли запись у источника. Поле `enabled` есть не у всех видов — у
 * команды и субагента состояния вкл/выкл в каноне нет вовсе, — поэтому спрашиваем
 * наличие поля, а не подставляем `true` там, где вопрос не имеет смысла.
 */
export function isDisabled(item: EnvItem): boolean {
  return 'enabled' in item && item.enabled === false;
}
