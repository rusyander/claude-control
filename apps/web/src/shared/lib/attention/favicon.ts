import type { AttentionTone } from './attention';

/**
 * Точка на значке вкладки. Значок рисуем сами в data-URL, а не подменяем файл:
 * SVG, загруженный как картинка, не имеет права тянуть внешние ресурсы, поэтому
 * «взять /favicon.svg и дорисовать поверх» браузер бы не дал. Знак приложения
 * повторён здесь — это зеркало `apps/web/public/favicon.svg`, и меняются они
 * вместе.
 */

const BASE_ART =
  '<rect width="32" height="32" rx="9" fill="#4f46e5"/>' +
  '<circle cx="16" cy="16" r="8.5" fill="none" stroke="#ffffff" stroke-width="2" ' +
  'stroke-linecap="round" stroke-dasharray="3.4 4.2" opacity="0.75"/>' +
  '<circle cx="16" cy="16" r="3.2" fill="#ffffff"/>';

/** Цвета метки берём фиксированными: значок живёт вне темы страницы. */
const TONE_COLOR: Record<AttentionTone, string> = { warning: '#f59e0b', danger: '#ef4444' };

function iconHref(tone: AttentionTone | undefined): string {
  const badge = tone
    ? `<circle cx="24" cy="8" r="7.5" fill="${TONE_COLOR[tone]}" stroke="#ffffff" stroke-width="2"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${BASE_ART}${badge}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Поставить (или снять) точку на значке вкладки. Ссылку ищем по `rel~=icon`, а
 * если её нет — заводим: без этого метка молча не появилась бы.
 */
export function applyFaviconBadge(tone: AttentionTone | undefined): void {
  if (typeof document === 'undefined') return;
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = iconHref(tone);
}
