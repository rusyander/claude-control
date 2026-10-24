import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SplitOverlapView } from '@agentdeck/contracts/chat-handoff';
import { SplitOverlapPanel } from './SplitOverlapPanel';
import { OVERLAP_OPEN_LIMIT, overlapFold } from '../../lib/overlapFold';

/**
 * Раздел пересечений веток в хабе родителя. Живой прогон 24.09.2026: 215 строк
 * (потом 389) без сворачивания выталкивали за экран строки групп и карточки
 * прав агентов. Проверяется сама разметка компонента, а не только правило.
 */

function overlapOf(count: number, outside = 0): SplitOverlapView {
  return {
    files: Array.from({ length: count }, (_, index) => ({
      path: `src/file-${index}.ts`,
      groups: [0, 1],
      outside: index < outside ? [1] : [],
    })),
    mergeOrder: [0, 1],
    unread: [{ index: 2, reason: 'fatal' }],
  } as unknown as SplitOverlapView;
}

const rowsIn = (html: string): number => html.match(/data-overlap-file=/g)?.length ?? 0;
const render = (overlap: SplitOverlapView, defaultExpanded?: boolean): string =>
  renderToStaticMarkup(
    <SplitOverlapPanel
      overlap={overlap}
      titleOf={(index) => `g${index}`}
      onCheck={() => {}}
      {...(defaultExpanded ? { defaultExpanded } : {})}
    />,
  );

describe('пересечения веток — сворачивание', () => {
  it('длинный список по умолчанию свёрнут: строк нет, заголовок-переключатель закрыт', () => {
    const html = render(overlapOf(215));

    expect(rowsIn(html)).toBe(0);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-overlap-fold="closed"');
  });

  it('свёрнутый список прячет и число файлов вне владения, и порядок слияния', () => {
    const html = render(overlapOf(215, 4));

    expect(rowsIn(html)).toBe(0);
    expect(html).not.toContain('chat.cascade.overlap.outsideCount');
    expect(html).not.toContain('chat.cascade.overlap.mergeOrder');
  });

  it('раскрытый список показывает число вне владения и порядок слияния', () => {
    const html = render(overlapOf(215, 4), true);

    expect(html).toContain('chat.cascade.overlap.outsideCount');
    expect(html).toContain('chat.cascade.overlap.mergeOrder');
  });

  it('раскрытый показывает все строки', () => {
    const html = render(overlapOf(215), true);

    expect(rowsIn(html)).toBe(215);
    expect(html).toContain('aria-expanded="true"');
  });

  it('даже один файл свёрнут до заголовка (владелец 22.10.2026)', () => {
    const html = render(overlapOf(1));

    expect(rowsIn(html)).toBe(0);
    expect(html).toContain('data-overlap-fold="closed"');
  });

  it('пустой список без переключателя', () => {
    const html = render(overlapOf(OVERLAP_OPEN_LIMIT));

    expect(rowsIn(html)).toBe(OVERLAP_OPEN_LIMIT);
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('data-overlap-fold');
  });

  it('порядок слияния и «не прочитано» — отдельными блоками, а не одной строкой', () => {
    const html = render(overlapOf(1), true);

    expect(html).toMatch(/<div[^>]*>chat\.cascade\.overlap\.mergeOrder<\/div>/);
    expect(html).toMatch(/<div[^>]*data-overlap-unread[^>]*>/);
  });

  it('правило сворачивания: граница — строго больше порога', () => {
    expect(overlapFold(OVERLAP_OPEN_LIMIT, false)).toEqual({ foldable: false, showRows: true });
    expect(overlapFold(OVERLAP_OPEN_LIMIT + 1, false)).toEqual({ foldable: true, showRows: false });
    expect(overlapFold(OVERLAP_OPEN_LIMIT + 1, true)).toEqual({ foldable: true, showRows: true });
  });
});
