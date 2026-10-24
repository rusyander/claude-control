import { describe, expect, it } from 'vitest';
import { absolutePath } from './reduce-util.ts';
import type { WatchContext } from './watch.types.ts';

const ctx = (extra: Partial<WatchContext> = {}): WatchContext =>
  ({ settings: {}, ...extra }) as WatchContext;

describe('absolutePath: сведение `..` (F-90)', () => {
  it('путь, сведённый до корня, остаётся корнем, а не пустой строкой', () => {
    expect(absolutePath('/tmp/x/../..', ctx())).toBe('/');
    expect(absolutePath('../..', ctx({ cwd: '/tmp/x' }))).toBe('/');
  });

  it('обычный путь сводится по месту', () => {
    expect(absolutePath('/tmp/x/./y/../z', ctx())).toBe('/tmp/x/z');
  });
});
