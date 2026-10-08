/**
 * Пропорция рисунка по корневому тегу. На телефоне у карточки нет «естественного»
 * размера, как у `<img>` в браузере: без пропорции SvgXml растянул бы картинку в
 * квадрат или сжал в полоску.
 */
export function svgRatio(svg: string): number {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(root)?.[1];
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const width = parts[2];
    const height = parts[3];
    if (parts.length === 4 && width && height && width > 0 && height > 0) return width / height;
  }
  const width = Number(/\bwidth\s*=\s*["']([\d.]+)["']/i.exec(root)?.[1]);
  const height = Number(/\bheight\s*=\s*["']([\d.]+)["']/i.exec(root)?.[1]);
  return width > 0 && height > 0 ? width / height : 1;
}
