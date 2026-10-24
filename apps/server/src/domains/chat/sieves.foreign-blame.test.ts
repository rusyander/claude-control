import { describe, expect, it } from 'vitest';
import { BUILTIN_SIEVES, judgeSieves } from '@agentdeck/contracts/sieves';
import { serverText } from '../../lib/server-texts/server-texts.ts';

/**
 * Живая группа 23.10: «чужие −» назвали только файлы. Агент не знал, чей
 * коммит и какие строки, и два одноимённых `users.mdx` снимал именем без пути —
 * судья такое не принимает. Пробел теперь несёт коммит и строки и просит
 * полный путь; снимается строка по-прежнему по пути.
 */

const applicable = BUILTIN_SIEVES.filter((sieve) => sieve.id === 'foreign-removals');
const mechanics = {
  foreignRemovals: ['docs/en/users.mdx', 'docs/ru/users.mdx'],
  foreignBlame: {
    'docs/en/users.mdx': 'db7091eede «docs: users page», lines 40-46',
    'docs/ru/users.mdx': 'db7091eede «docs: users page», lines 38',
  },
};

describe('пробел «чужие −»: коммит, строки и полный путь', () => {
  it('в пробеле — sha, тема и строки каждого файла; текст просит полный путь', () => {
    const [gap] = judgeSieves({ applicable, rows: [], mechanics });
    expect(gap?.code).toBe('sieve-gap-foreign-removals');
    expect(gap?.params.files).toBe(
      'docs/en/users.mdx (db7091eede «docs: users page», lines 40-46), ' +
        'docs/ru/users.mdx (db7091eede «docs: users page», lines 38)',
    );
    const ru = serverText('sieve-gap-foreign-removals', gap?.params ?? {});
    expect(ru).toContain('lines 40-46');
    expect(ru).toContain('полным путём');
  });

  it('снимает строка с полными путями; одно имя файла — нет', () => {
    const judge = (evidence: string) =>
      judgeSieves({
        applicable,
        rows: [{ id: 'foreign-removals', status: 'n/a', evidence }],
        mechanics,
      });
    expect(judge('users.mdx: the callout is rewritten by the task on purpose')).toHaveLength(1);
    expect(
      judge(
        'docs/en/users.mdx and docs/ru/users.mdx: db7091eede callout rewritten by the task on purpose',
      ),
    ).toEqual([]);
  });

  it('без сведений о коммите — как раньше, один путь', () => {
    const [gap] = judgeSieves({ applicable, rows: [], mechanics: { foreignRemovals: ['a.ts'] } });
    expect(gap?.params.files).toBe('a.ts');
  });
});
