import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import type { CardText } from './model.types';
import { cardPreview } from './cardPreview';

export interface CardField {
  label: string;
  value: string;
  /** Длинное или многострочное значение — показываем в прокрутке, целиком. */
  long: boolean;
}

/**
 * Поля карточки. Подпись и значение с кодом — словарём телефона (`text`), без
 * кода — русский запасной текст сервера; данные (путь, промпт) кода не несут и
 * не переводятся. Значение показывается ЦЕЛИКОМ — решение принимают по тому,
 * что будет выполнено, а не по началу строки. Двуязычные данные (заголовки
 * шагов) — стороной языка телефона, см. `cardPreview`.
 */
export function cardFields(
  pending: PanelPendingAction,
  text: CardText = (_code, _params, fallback) => fallback,
  language = 'ru',
): CardField[] {
  return cardPreview(pending, language).fields.map((field) => {
    const value = text(field.valueCode, field.valueParams, field.value);
    return {
      label: text(field.labelCode, field.labelParams, field.label),
      value,
      long: value.length > 160 || value.includes('\n'),
    };
  });
}
