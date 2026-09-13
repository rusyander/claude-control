import { deckLine } from '../text.ts';

/**
 * Разметка: экранирование и мелкие сборщики.
 *
 * Ни один знак из колоды не попадает в страницу мимо `esc()`. Текст слайдов —
 * это ответ модели, то есть чужой ввод: `<script>` в заголовке обязан остаться
 * ТЕКСТОМ заголовка. Единственное исключение — схема (`figure`), и она приходит
 * уже проверенной тем же разбором, что рисунок режима «Картинка кодом».
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Экранирование для текста и для значения атрибута сразу. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** Чистая строка колоды, готовая к вставке в разметку. */
export function esc(value: unknown): string {
  return escapeHtml(deckLine(value));
}

/** Абзацы из многострочного текста: перевод строки — это новый абзац. */
export function paragraphs(value: unknown, className = ''): string {
  const attr = className ? ` class="${className}"` : '';
  return deckLine(value)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p${attr}>${escapeHtml(line)}</p>`)
    .join('');
}

/** Порядковый номер с ведущим нулём: «03» читается как номер, «3» — как счёт. */
export function ordinal(index: number): string {
  return String(index).padStart(2, '0');
}

/**
 * Шаг раскрытия для дорожки прокрутки. Значение уезжает в `--i`, а из него
 * считается сдвиг диапазона анимации: пункты появляются по очереди, а не разом.
 */
export function stagger(index: number): string {
  return ` style="--i:${index}"`;
}
