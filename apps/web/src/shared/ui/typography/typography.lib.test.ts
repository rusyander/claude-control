import { describe, expect, it } from 'vitest';
import { defaultTag } from './typography.lib';
import { clampStyle } from './clampStyle';

describe('clampStyle', () => {
  it('обрезка ложится поверх стиля вызывающего, а не стирается им', () => {
    expect(clampStyle(2, { color: 'red' })).toEqual({ color: 'red', WebkitLineClamp: 2 });
  });

  it('без обрезки — стиль вызывающего как есть', () => {
    const style = { color: 'red' };
    expect(clampStyle(undefined, style)).toBe(style);
    expect(clampStyle(undefined, undefined)).toBeUndefined();
  });
});

describe('defaultTag', () => {
  it('заголовки — заголовочными тегами, подписи — span, остальное — p', () => {
    expect(defaultTag('heading-lg')).toBe('h1');
    expect(defaultTag('caption')).toBe('span');
    expect(defaultTag('body')).toBe('p');
  });
});
