import type { ActionRow } from './ProviderHooks.types';
import type { ProviderHookAction } from '@agentdeck/contracts';

/**
 * Состояние формы → черновик для сервера. Пустые аргументы и переменные без
 * имени отбрасываются: они появляются, когда пользователь добавил строку и не
 * заполнил её, и отправлять их значило бы получить 400 на ровном месте.
 * Действие без единого аргумента и группа без действий выпадают целиком.
 */
export function toActionDraft(action: ActionRow): ProviderHookAction | undefined {
  const command = action.command.map((row) => row.value.trim()).filter((value) => value.length > 0);
  if (command.length === 0) return undefined;

  const environment = action.env
    .map((row) => ({ key: row.key.trim(), value: row.value }))
    .filter((pair) => pair.key.length > 0);

  return { command, ...(environment.length > 0 ? { environment } : {}) };
}
