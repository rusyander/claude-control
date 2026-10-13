import { describe, expect, it } from 'vitest';
import type { ProjectInfo } from '@entities/Project';
import { withRegistry } from './withRegistry';

const info = (path: string, lastActivity: string, exists = true): ProjectInfo => ({
  path,
  name: path.split('/').pop() ?? path,
  exists,
  lastActivity,
  chats: [],
});

describe('withRegistry', () => {
  it('записи реестра — первыми и всегда, история без реестра — следом', () => {
    const history = [
      info('C:/work/alpha', '2026-10-13T10:00:00Z'),
      info('C:/work/Beta', '2026-10-12T10:00:00Z'),
      info('C:/work/gone', '2026-10-11T10:00:00Z', false),
    ];
    const registry = [
      { id: 'b', name: 'Beta', path: 'c:\\work\\beta\\' },
      { id: 'z', name: 'zeta', path: 'C:/work/zeta' },
    ];

    const listed = withRegistry(history, registry);

    expect(listed.map((row) => [row.info.path, row.registered?.id])).toEqual([
      ['C:/work/Beta', 'b'],
      ['C:/work/zeta', 'z'],
      ['C:/work/alpha', undefined],
    ]);
    expect(listed[1]?.info).toMatchObject({ exists: true, chats: [], lastActivity: '' });
  });

  it('пропавший с диска каталог из реестра не выпадает, из истории — выпадает', () => {
    const listed = withRegistry(
      [info('C:/a', '2026-01-01T00:00:00Z', false), info('C:/b', '2026-01-01T00:00:00Z', false)],
      [{ id: 'a', name: 'a', path: 'C:/a' }],
    );
    expect(listed.map((row) => row.info.path)).toEqual(['C:/a']);
  });
});
