import type { TFunction } from 'i18next';
import { isPanelTextCode, type PanelTextParams } from '@agentdeck/contracts/panel-agent';

/**
 * Текст карточки или следа на языке окна: код сервера — своим словарём,
 * без кода (старая запись следа, новый код у старого окна) — русская строка
 * сервера как есть. Значение-данные (путь, промпт) кода не несёт и не
 * переводится.
 */
export function panelText(
  t: TFunction,
  code: string | undefined,
  params: PanelTextParams | undefined,
  fallback: string,
): string {
  if (!code || !isPanelTextCode(code)) return fallback;
  return t(`panelAgent.text.${code}`, { ...params });
}
