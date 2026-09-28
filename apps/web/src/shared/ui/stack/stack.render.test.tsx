import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Stack } from './stack';

/**
 * Свой `style` вызывающего дополняет раскладку из пропов, а не заменяет её
 * (ревью 28.09, сосед F-241): `<Stack gap style>` терял `gap` молча.
 */
describe('Stack и style вызывающего', () => {
  it('gap из пропа остаётся рядом со своим style', () => {
    const html = renderToStaticMarkup(
      <Stack gap="var(--spacing-2xs)" style={{ listStyle: 'none' }}>
        x
      </Stack>,
    );

    expect(html).toContain('gap:var(--spacing-2xs)');
    expect(html).toContain('list-style:none');
  });

  it('то же свойство — побеждает вызывающий', () => {
    const html = renderToStaticMarkup(
      <Stack gap="4px" style={{ gap: '8px' }}>
        x
      </Stack>,
    );

    expect(html).toContain('gap:8px');
    expect(html).not.toContain('gap:4px');
  });
});
