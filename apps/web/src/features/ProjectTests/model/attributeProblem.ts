import type { ProjectTestAttributeDef } from '@agentdeck/contracts';

/**
 * Что не так со своим полем — строкой для человека, или ничего.
 *
 * Проверяется то же, что и на сервере, и по той же причине: ключ уезжает в
 * каждый кейс (`attributes[key]`), а поле-выбор без вариантов нечем заполнить.
 * Дублировать не жалко — форма обязана сказать это ДО отправки, а сервер
 * остаётся последним рубежом для всех остальных входов.
 */
export function attributeProblem(
  draft: ProjectTestAttributeDef,
  existing: ProjectTestAttributeDef[],
  originalKey?: string,
): 'key' | 'duplicate' | 'options' | undefined {
  const key = draft.key.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) return 'key';
  if (key !== originalKey && existing.some((item) => item.key === key)) return 'duplicate';
  if (draft.type === 'select' && (draft.options ?? []).filter(Boolean).length === 0) {
    return 'options';
  }
  return undefined;
}
