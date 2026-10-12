import { describe, expect, it } from 'vitest';
import type { ChangelogEntry, ChangelogKind } from '@agentdeck/contracts/changelog';
import { areaShares } from './areaShares';
import { entryKinds, filterEntries, kindCounts } from './filter';
import { KIND_ORDER } from './kinds';
import { pickText } from './pickText';

const entry = (
  id: string,
  source: ChangelogEntry['source'],
  kind: ChangelogKind,
  itemKinds: ChangelogKind[] = [],
): ChangelogEntry => ({
  id,
  source,
  status: 'released',
  date: '2026-10-12T00:00:00Z',
  kind,
  title: { ru: id },
  items: itemKinds.map((k) => ({ kind: k, text: { ru: 'x' }, images: [] })),
  images: [],
  links: [],
  commits: [],
  areas: [],
  totals: { files: 0, insertions: 0, deletions: 0 },
});

describe('pickText', () => {
  it('английский — только если задан и язык английский; иначе русский', () => {
    expect(pickText({ ru: 'да', en: 'yes' }, 'en')).toBe('yes');
    expect(pickText({ ru: 'да', en: 'yes' }, 'en-US')).toBe('yes');
    expect(pickText({ ru: 'да', en: 'yes' }, 'ru')).toBe('да');
    expect(pickText({ ru: 'да' }, 'en')).toBe('да');
    expect(pickText(undefined, 'en')).toBe('');
  });
});

describe('фильтры ленты', () => {
  const entries = [
    entry('a', 'curated', 'added', ['added', 'fixed']),
    entry('b', 'git', 'fixed'),
    entry('c', 'git', 'docs', ['docs']),
  ];

  it('виды записи: из пунктов, а без пунктов — главный вид', () => {
    expect([...entryKinds(entries[0]!)]).toEqual(['added', 'fixed']);
    expect([...entryKinds(entries[1]!)]).toEqual(['fixed']);
  });

  it('источник и вид сужают вместе; пустой набор видов не сужает', () => {
    const none = new Set<ChangelogKind>();
    expect(filterEntries(entries, 'all', none).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(filterEntries(entries, 'git', none).map((e) => e.id)).toEqual(['b', 'c']);
    expect(filterEntries(entries, 'all', new Set(['fixed'] as const)).map((e) => e.id)).toEqual([
      'a',
      'b',
    ]);
    expect(filterEntries(entries, 'curated', new Set(['docs'] as const))).toEqual([]);
  });

  it('правки рабочей копии: видов нет, «Из git» их включает, «Описанные» — нет', () => {
    const withTree = [...entries, entry('tree', 'tree', 'changed')];
    expect(entryKinds(withTree[3]!).size).toBe(0);
    expect(filterEntries(withTree, 'git', new Set()).map((e) => e.id)).toEqual(['b', 'c', 'tree']);
    expect(filterEntries(withTree, 'curated', new Set()).map((e) => e.id)).toEqual(['a']);
    // Вид отбирает по видам записи: у карточки правок их нет, под отбор она не попадает.
    expect(filterEntries(withTree, 'all', new Set(['changed'] as const))).toEqual([]);
    expect(kindCounts(withTree, 'all').has('changed')).toBe(false);
  });

  it('счётчики чипов считают записи выбранного источника', () => {
    expect(Object.fromEntries(kindCounts(entries, 'all'))).toEqual({ added: 1, fixed: 2, docs: 1 });
    expect(Object.fromEntries(kindCounts(entries, 'git'))).toEqual({ fixed: 1, docs: 1 });
  });

  it('порядок видов один на всю вкладку', () => {
    expect(KIND_ORDER).toEqual([
      'added',
      'improved',
      'fixed',
      'changed',
      'removed',
      'docs',
      'internal',
    ]);
  });
});

describe('areaShares', () => {
  const area = (a: ChangelogEntry['areas'][number]['area'], insertions: number, deletions = 0) => ({
    area: a,
    files: 1,
    insertions,
    deletions,
  });

  it('доли по строкам и в сумме сто', () => {
    const shares = areaShares([area('web', 75), area('server', 25)]);
    expect(shares.map((s) => Math.round(s.percent))).toEqual([75, 25]);
    expect(shares.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100, 6);
  });

  it('крошечная область остаётся видимой, сумма по-прежнему сто', () => {
    const shares = areaShares([area('web', 100000), area('docs', 1)]);
    expect(shares[1]!.percent).toBeGreaterThan(1.9);
    expect(shares.reduce((sum, s) => sum + s.percent, 0)).toBeCloseTo(100, 6);
  });

  it('область без строк (двоичные файлы) всё равно получает сегмент; пустой список — пусто', () => {
    expect(areaShares([area('other', 0)])[0]!.percent).toBeCloseTo(100, 6);
    expect(areaShares([])).toEqual([]);
  });
});
