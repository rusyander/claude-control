import type { ProviderHookAction, ProviderHookPatternGroup } from '@claude-control/contracts';
import type { ActionRow, PatternRow } from './ProviderHooks.types';

let counter = 0;
/** Следующий идентификатор строки формы (монотонный, к данным отношения не имеет). */
export function nextRowId(): number {
  counter += 1;
  return counter;
}

/** Ответ сервера → состояние формы. */
export function toActionRow(action: ProviderHookAction): ActionRow {
  return {
    id: nextRowId(),
    command: action.command.map((value) => ({ id: nextRowId(), value })),
    env: (action.environment ?? []).map((pair) => ({
      id: nextRowId(),
      key: pair.key,
      value: pair.value,
    })),
  };
}

export function toPatternRow(group: ProviderHookPatternGroup): PatternRow {
  return {
    id: nextRowId(),
    pattern: group.pattern,
    actions: group.actions.map(toActionRow),
  };
}

/** Пустое действие с одной строкой команды — так форма сразу пригодна для ввода. */
export function emptyActionRow(): ActionRow {
  return { id: nextRowId(), command: [{ id: nextRowId(), value: '' }], env: [] };
}

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

export function toPatternDraft(row: PatternRow): ProviderHookPatternGroup | undefined {
  const pattern = row.pattern.trim();
  if (!pattern) return undefined;
  const actions = row.actions
    .map(toActionDraft)
    .filter((action): action is ProviderHookAction => Boolean(action));
  return actions.length > 0 ? { pattern, actions } : undefined;
}

/** Стабильное представление черновика — им сравнивается «изменилось ли». */
export function stableDraft(value: unknown): string {
  return JSON.stringify(value);
}
