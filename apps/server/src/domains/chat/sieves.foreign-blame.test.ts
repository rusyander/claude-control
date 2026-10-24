import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SIEVES,
  judgeSieves,
  scanSieveBlocks,
  SIEVE_LANG,
} from '@agentdeck/contracts/sieves';
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

/**
 * Живая группа !1072 (24.10): 12 одноимённых `index.tsx` — назвать можно только
 * полными путями, это ~1000 знаков, а строка обрезалась на 600. Судья не видел
 * хвоста, пробел прятал семь путей за «(+7)», и одна и та же строка сдавалась
 * кругами до сдачи группы человеку. Строка идёт настоящим путём: блок ответа →
 * разбор → судья.
 */
describe('строка «чужие −» с длинным списком путей', () => {
  const files = Array.from(
    { length: 12 },
    (_, at) => `inst-chat-ui/src/app/config/router/guards/RequireChatAccess/part-${at}/index.tsx`,
  );
  const report = (named: readonly string[]) =>
    scanSieveBlocks(
      `Отчёт.\n\`\`\`${SIEVE_LANG}\n` +
        JSON.stringify({
          sieves: [
            {
              id: 'foreign-removals',
              status: 'pass',
              evidence: `intended, branch rebuilt on !1059. Files: ${named.join(', ')}`,
            },
          ],
        }) +
        '\n```',
    ).rows;

  it('строка длиннее 600 знаков доходит до судьи целиком и снимает пробел', () => {
    const rows = report(files);
    expect(rows[0]?.evidence.length).toBeGreaterThan(600);
    expect(judgeSieves({ applicable, rows, mechanics: { foreignRemovals: files } })).toEqual([]);
  });

  it('пробел называет каждый ещё не названный путь, без «(+N)»', () => {
    const rows = report(files.slice(0, 9));
    const [gap] = judgeSieves({ applicable, rows, mechanics: { foreignRemovals: files } });
    expect(gap?.code).toBe('sieve-gap-foreign-removals');
    expect(gap?.params.files).toBe(files.slice(9).join(', '));
  });

  it('без строки пробел называет все пути', () => {
    const [gap] = judgeSieves({ applicable, rows: [], mechanics: { foreignRemovals: files } });
    expect(gap?.params.files).toBe(files.join(', '));
  });

  it('у сита без имён в доказательстве потолок прежний', () => {
    const rows = scanSieveBlocks(
      `\`\`\`${SIEVE_LANG}\n` +
        JSON.stringify({
          sieves: [{ id: 'merge-tree', status: 'pass', evidence: 'x'.repeat(900) }],
        }) +
        '\n```',
    ).rows;
    expect(rows[0]?.evidence).toHaveLength(600);
  });
});
