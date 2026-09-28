import {
  formatPanelText,
  isPanelTextCode,
  type PanelTextParams,
} from '@agentdeck/contracts/panel-agent';
import type { PanelTextDictionary } from '../../shared/config/i18n/panel-texts/texts.ru';

/**
 * Текст карточки агента на языке телефона — тем же словарём по коду, что у окна
 * панели (копия файл в файл, сверяет `pnpm mobile:contracts`). Без кода (старая
 * запись, код новее телефона) — русская строка сервера как есть: телефон раньше
 * показывал её всегда, и английский телефон читал карточку по-русски.
 *
 * Формы числа — ключами i18next (`<код>_one`, `_few`…), как в панели. Форму
 * выбирает `pluralForm`, а не `Intl.PluralRules`: в Hermes телефона его нет, и
 * карточка с числом роняла всё приложение.
 */
export function panelText(
  texts: PanelTextDictionary,
  language: string,
  code: string | undefined,
  params: PanelTextParams | undefined,
  fallback: string,
): string {
  if (!code || !isPanelTextCode(code)) return fallback;
  const table = texts as Record<string, string | undefined>;
  const count = params?.count;
  const form = typeof count === 'number' ? pluralForm(language, count) : undefined;
  const template =
    (form ? table[`${code}_${form}`] : undefined) ??
    table[code] ??
    (form ? table[`${code}_other`] : undefined);
  return template === undefined ? fallback : formatPanelText(template, params);
}

/** Правила CLDR для двух языков телефона; дробное число — `other`, как у Intl. */
function pluralForm(language: string, count: number): Intl.LDMLPluralRule {
  if (!Number.isInteger(count)) return 'other';
  const n = Math.abs(count);
  if (!language.startsWith('ru')) return n === 1 ? 'one' : 'other';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'one';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few';
  return 'many';
}
