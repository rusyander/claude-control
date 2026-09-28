import { describe, expect, it } from 'vitest';
import {
  acceptLearned,
  applicableSieves,
  BUILTIN_SIEVES,
  checkSimilarity,
  judgeSieves,
  LEARN_SIEVES_LINE,
  mergeSieveRows,
  scanSieveBlocks,
  SIEVE_LANG,
  sievePromptBlock,
  touchKinds,
  withoutSieveBlocks,
  type SieveDef,
} from '@agentdeck/contracts/sieves';

/**
 * Сита перед MR (решение владельца 28.09): применимость по путям, блок отчёта,
 * судья и приём выученных сит. Судья — то, что держит «готово» группы, поэтому
 * каждая ветка его решения проверена отдельно, включая ту, что НЕ снимается.
 */
const fenced = (body: string): string => `\`\`\`${SIEVE_LANG}\n${body}\n\`\`\``;
const byId = (...ids: string[]): SieveDef[] =>
  BUILTIN_SIEVES.filter((sieve) => ids.includes(sieve.id));

describe('применимость сит по путям', () => {
  it('UI, бэкенд, контракт и код различаются по пути', () => {
    expect([...touchKinds(['apps/web/src/Button.tsx'])].sort()).toEqual(['code', 'ui']);
    expect([...touchKinds(['svc/handler.go'])].sort()).toEqual(['backend', 'code']);
    expect([...touchKinds(['apps/server/src/routes/a.ts'])].sort()).toEqual(['backend', 'code']);
    expect([...touchKinds(['docs/api.md'])]).toEqual(['contract']);
    expect([...touchKinds(['api/openapi.yaml'])]).toContain('contract');
    expect([...touchKinds(['packages/contracts/src/chat.ts'])]).toContain('contract');
  });

  it('тесты, служебные каталоги агентов и .agent/ ничего не включают', () => {
    expect([...touchKinds(['e2e/login.spec.ts', 'src/a.test.tsx'])]).toEqual([]);
    expect([...touchKinds(['.agent/notes.md', '.claude/rules/x.md'])]).toEqual([]);
  });

  it('пустой дифф — ни одного сита; любой дифф — интеграционные всегда', () => {
    expect(applicableSieves([])).toEqual([]);
    const ids = applicableSieves(['README.md']).map((sieve) => sieve.id);
    expect(ids).toEqual(['contract-by-request', 'merge-tree', 'foreign-removals']);
  });

  it('UI-правка тянет браузерный фокус, бэкенд — стенд своей ветки', () => {
    const ui = applicableSieves(['src/Page.tsx']).map((sieve) => sieve.id);
    expect(ui).toContain('browser-focus');
    expect(ui).not.toContain('branch-backend-stand');
    const backend = applicableSieves(['server/api.py']).map((sieve) => sieve.id);
    expect(backend).toContain('branch-backend-stand');
    expect(backend).toContain('contract-by-request');
    expect(backend).not.toContain('browser-focus');
  });
});

describe('блок отчёта о ситах', () => {
  it('разобранный блок уходит из текста, строки и выученное — в разбор', () => {
    const scan = scanSieveBlocks(
      `Готово.\n\n${fenced(
        '{"sieves":[{"id":"browser-focus","status":"PASS","evidence":"npx playwright test → 4 passed"}],' +
          '"learned":[{"thread":"https://h/g/p/-/merge_requests/1#note_9","class":"contract","scope":"global","trigger":"docs change","check":"curl the endpoint and compare the documented status"}]}',
      )}\n\nhttps://h/g/p/-/merge_requests/1`,
    );
    expect(scan.text).toBe('Готово.\n\nhttps://h/g/p/-/merge_requests/1');
    expect(scan.rows).toEqual([
      { id: 'browser-focus', status: 'pass', evidence: 'npx playwright test → 4 passed' },
    ]);
    expect(scan.learned[0]).toMatchObject({ class: 'contract', scope: 'global' });
    expect(scan.rejected).toBe(0);
  });

  it('сломанный блок остаётся текстом, неизвестный статус и класс не проходят', () => {
    const broken = `x\n${fenced('{"sieves":')}`;
    expect(scanSieveBlocks(broken).text).toBe(broken);
    expect(scanSieveBlocks(broken).rejected).toBe(1);
    const odd = scanSieveBlocks(
      fenced(
        '{"sieves":[{"id":"a","status":"ok","evidence":"x"}],"learned":[{"thread":"t","class":"taste","trigger":"tr","check":"c"}]}',
      ),
    );
    expect(odd.rows).toEqual([]);
    expect(odd.learned[0]?.class).toBe('other');
  });

  it('незакрытый блок прячется только в потоке', () => {
    const open = `Ответ\n\`\`\`${SIEVE_LANG}\n{"sieves":[`;
    expect(withoutSieveBlocks(open, { streaming: true })).toBe('Ответ');
    expect(withoutSieveBlocks(open)).toBe(open);
  });

  it('строки звеньев складываются, новая строка сита заменяет прежнюю', () => {
    const merged = mergeSieveRows(
      [{ id: 'a', status: 'fail', evidence: 'red' }],
      [
        { id: 'a', status: 'pass', evidence: 'green now' },
        { id: 'b', status: 'n/a', evidence: 'no ui' },
      ],
    );
    expect(merged).toEqual([
      { id: 'a', status: 'pass', evidence: 'green now' },
      { id: 'b', status: 'n/a', evidence: 'no ui' },
    ]);
  });
});

describe('судья сит перед «доставлено»', () => {
  const evidence = 'npx playwright test focus.spec.ts → 4 passed';

  it('всё сдано с доказательством и механика чиста — пробелов нет', () => {
    expect(
      judgeSieves({
        applicable: byId('browser-focus', 'merge-tree', 'foreign-removals'),
        rows: [{ id: 'browser-focus', status: 'pass', evidence }],
        mechanics: {},
      }),
    ).toEqual([]);
  });

  it('несданное, без доказательства и проваленное — три разных пробела', () => {
    const gaps = judgeSieves({
      applicable: byId('browser-focus', 'boundary-negative', 'branch-backend-stand'),
      rows: [
        { id: 'boundary-negative', status: 'pass', evidence: 'ok' },
        { id: 'branch-backend-stand', status: 'fail', evidence: 'stand runs main' },
      ],
      mechanics: {},
    });
    // Порядок — порядок каталога: фокус, стенд своей ветки, граница.
    expect(gaps.map((gap) => gap.code)).toEqual([
      'sieve-gap-unreported',
      'sieve-gap-failed',
      'sieve-gap-no-evidence',
    ]);
    expect(gaps[0]?.params).toMatchObject({ sieve: 'browser-focus', lang: SIEVE_LANG });
  });

  it('конфликт со свежей основной не снимается ничем', () => {
    const gaps = judgeSieves({
      applicable: byId('merge-tree'),
      rows: [{ id: 'merge-tree', status: 'n/a', evidence: 'src/a.ts conflict is fine, trust me' }],
      mechanics: { conflicts: ['src/a.ts'] },
    });
    expect(gaps.map((gap) => gap.code)).toEqual(['sieve-gap-conflicts']);
  });

  it('чужие «−» снимаются только строкой, где назван КАЖДЫЙ файл', () => {
    const base = {
      applicable: byId('foreign-removals'),
      mechanics: { foreignRemovals: ['src/a.ts', 'src/deep/b.ts'] },
    };
    expect(
      judgeSieves({
        ...base,
        rows: [{ id: 'foreign-removals', status: 'n/a', evidence: 'removed on purpose in a.ts' }],
      }).map((gap) => gap.code),
    ).toEqual(['sieve-gap-foreign-removals']);
    expect(
      judgeSieves({
        ...base,
        rows: [
          {
            id: 'foreign-removals',
            status: 'n/a',
            evidence: 'a.ts: dead flag removed by the task; b.ts: moved to c.ts',
          },
        ],
      }),
    ).toEqual([]);
  });

  it('одноимённые файлы в разных папках: имя без пути не снимает ни один', () => {
    const base = {
      applicable: byId('foreign-removals'),
      mechanics: { foreignRemovals: ['apps/a/index.ts', 'apps/b/index.ts', 'apps/c/index.ts'] },
    };
    const judge = (evidence: string) =>
      judgeSieves({ ...base, rows: [{ id: 'foreign-removals', status: 'n/a', evidence }] });
    expect(judge('index.ts removal intended by the task').map((gap) => gap.code)).toEqual([
      'sieve-gap-foreign-removals',
    ]);
    expect(
      judge('apps/a/index.ts, apps/b/index.ts, apps\\c\\index.ts: barrels merged by the task'),
    ).toEqual([]);
  });

  it('потребители: срабатывание вытесняет «несдано», снимается названием файлов', () => {
    const mechanics = { consumers: [{ token: 'fooBar', files: ['e2e/x.spec.ts'] }] };
    const flagged = judgeSieves({
      applicable: byId('consumers-repo-wide'),
      rows: [],
      mechanics,
    });
    expect(flagged.map((gap) => gap.code)).toEqual(['sieve-gap-consumers']);
    expect(flagged[0]?.params).toMatchObject({ tokens: 'fooBar', files: 'e2e/x.spec.ts' });
    expect(
      judgeSieves({
        applicable: byId('consumers-repo-wide'),
        rows: [
          {
            id: 'consumers-repo-wide',
            status: 'pass',
            evidence: 'git grep fooBar; x.spec.ts updated',
          },
        ],
        mechanics,
      }),
    ).toEqual([]);
  });
});

describe('выученные сита', () => {
  const row = {
    thread: 'https://h/g/p/-/merge_requests/7#note_42',
    class: 'contract' as const,
    scope: 'project' as const,
    trigger: 'a handler status code changes',
    check: 'curl the endpoint on the branch stand and compare with docs/api.md',
  };

  it('принимается только сито с тредом, который панель сама переслала', () => {
    expect(acceptLearned(row, [row.thread])).toBeUndefined();
    expect(acceptLearned(row, ['https://h/g/p/-/merge_requests/7#note_41'])).toBe('unknown-thread');
    expect(acceptLearned({ ...row, check: 'check it' }, [row.thread])).toBe('too-short');
  });

  it('похожие проверки узнаются, разные — нет', () => {
    expect(
      checkSimilarity(
        'curl the endpoint on the branch stand and compare with docs',
        'compare docs with curl of the endpoint on the branch stand',
      ),
    ).toBeGreaterThanOrEqual(0.5);
    expect(checkSimilarity('run playwright focus test', 'curl endpoint compare docs')).toBe(0);
  });

  it('задание по тредам MR просит блок сит с дословной ссылкой', () => {
    expect(LEARN_SIEVES_LINE).toContain(SIEVE_LANG);
    expect(LEARN_SIEVES_LINE).toContain('exactly as listed');
  });
});

describe('абзац сит в задании звена', () => {
  it('ревью получает свои сита, доставка — все, сданное не повторяется', () => {
    const applicable = applicableSieves(['src/Page.tsx', 'docs/api.md']);
    const review = sievePromptBlock({ stage: 'review', applicable });
    expect(review).toContain('[contract-by-request]');
    expect(review).toContain('[consumers-repo-wide]');
    expect(review).not.toContain('[browser-focus]');
    const deliver = sievePromptBlock({
      stage: 'deliver',
      applicable,
      done: [
        { id: 'contract-by-request', status: 'pass', evidence: 'curl /api/x → 404 as documented' },
      ],
    });
    expect(deliver).toContain('[browser-focus]');
    expect(deliver).not.toContain('[contract-by-request]');
    expect(deliver).toContain(SIEVE_LANG);
  });

  it('выученные сита идут в задание с числом повторов', () => {
    const block = sievePromptBlock({
      stage: 'deliver',
      applicable: [],
      learned: [
        {
          class: 'boundary',
          trigger: 'a form field limit changes',
          check: 'submit max+1 characters on the stand',
          sources: [
            { thread: 'a', at: '2026-09-28' },
            { thread: 'b', at: '2026-09-28' },
          ],
        },
      ],
    });
    expect(block).toContain('[boundary] when a form field limit changes → submit max+1');
    expect(block).toContain('(seen 2×)');
  });

  it('нет ни применимых, ни выученных — абзаца нет', () => {
    expect(sievePromptBlock({ stage: 'review', applicable: [] })).toBe('');
  });
});
