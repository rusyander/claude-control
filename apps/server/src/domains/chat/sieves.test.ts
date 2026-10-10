import { describe, expect, it } from 'vitest';
import {
  acceptLearned,
  applicableSieves,
  BUILTIN_SIEVES,
  checkSimilarity,
  isProductCode,
  isTestPath,
  judgeSieves,
  LEARN_SIEVES_LINE,
  liveNaIds,
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
    // Вид решает расширение (Ф3): TS сервера — код, бэкенд — по языку бэкенда.
    expect([...touchKinds(['apps/server/src/routes/a.ts'])].sort()).toEqual(['code']);
    expect([...touchKinds(['docs/api.md'])]).toEqual(['contract']);
    expect([...touchKinds(['api/openapi.yaml'])]).toContain('contract');
    expect([...touchKinds(['packages/contracts/src/chat.ts'])]).toContain('contract');
  });

  // Ф3: папка `tests/`/`qa/` не делает код тестом, `api/`/`services/` — бэкендом.
  const kindsTable: [string, string[], boolean][] = [
    ['apps/mobile/src/entities/tests/model.ts', ['code'], false],
    ['apps/mobile/src/features/tests/ui/List.tsx', ['code', 'ui'], false],
    ['tools/qa/check-help.mjs', ['code'], false],
    ['apps/web/src/shared/api/client.ts', ['code'], false],
    ['apps/web/src/entities/Chat/services/stream.ts', ['code'], false],
    ['services/billing/charge.go', ['backend', 'code'], false],
    ['server/api.py', ['backend', 'code'], false],
    // Корень тестов вне `src/` — тест (живое разделение 10.10); внутри `src/` — код.
    ['tests/fixtures/data.json', [], true],
    ['test.mjs', [], true],
    ['test/run.js', [], true],
    ['packages/lib/tests/parse.ts', [], true],
    ['e2e/helpers.ts', [], true],
    ['spec/support/helpers.rb', [], true],
    ['src/test.ts', ['code'], false],
    ['apps/web/src/shared/test/render.ts', ['code'], false],
    ['docs/api_spec.yaml', ['contract'], false],
    ['src/a.test.ts', [], true],
    ['e2e/login.spec.ts', [], true],
    ['cypress/e2e/login.cy.ts', [], true],
    ['pkg/handler_test.go', [], true],
    ['tests/test_api.py', [], true],
    ['spec/models/user_spec.rb', [], true],
    ['src/test/java/UserServiceTest.java', [], true],
    ['src/__tests__/list.js', [], true],
    ['src/Button.stories.tsx', [], true],
  ];
  for (const [path, kinds, test] of kindsTable) {
    it(`вид пути: ${path} → [${kinds.join(', ')}]${test ? ', тест' : ''}`, () => {
      expect([...touchKinds([path])].sort()).toEqual(kinds);
      expect(isTestPath(path)).toBe(test);
      expect(isProductCode(path)).toBe(!test && kinds.includes('code'));
    });
  }

  it('тесты, служебные каталоги агентов и .agent/ ничего не включают', () => {
    expect([...touchKinds(['e2e/login.spec.ts', 'src/a.test.tsx'])]).toEqual([]);
    expect([...touchKinds(['.agent/notes.md', '.claude/rules/x.md'])]).toEqual([]);
  });

  it('пустой дифф — ни одного сита; любой дифф — интеграционные всегда', () => {
    expect(applicableSieves([])).toEqual([]);
    const ids = applicableSieves(['README.md']).map((sieve) => sieve.id);
    // Механика панели идёт на любой дифф: секреты, lockfile, остатки отладки,
    // лишнее в git и новые переменные ищутся везде, где что-то добавлено.
    expect(ids).toEqual([
      'contract-by-request',
      'merge-tree',
      'foreign-removals',
      'lockfile-sync',
      'secrets',
      'debug-leftovers',
      'committed-artifacts',
      'env-config',
    ]);
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

  // Ревью PR #1: обновлённая строка держала старое место и первой уходила под обрезку.
  it('при обрезке до предела теряется самая старая строка, а не свежий вердикт', () => {
    const previous = Array.from({ length: 30 }, (_, index) => ({
      id: `s${index}`,
      status: 'fail' as const,
      evidence: 'old',
    }));
    const merged = mergeSieveRows(previous, [
      { id: 's0', status: 'pass', evidence: 'fresh' },
      { id: 's30', status: 'pass', evidence: 'new' },
    ]);
    expect(merged).toHaveLength(30);
    expect(merged.find((row) => row.id === 's0')).toMatchObject({ evidence: 'fresh' });
    expect(merged.some((row) => row.id === 's1')).toBe(false);
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

  // Решение владельца 10.10: живая проверка сдаётся n/a только на диффе без файлов
  // поведения — правка кода «не применимой» не бывает.
  it('живая проверка n/a при файлах поведения — пробел с файлами; без них — принята', () => {
    const naRow = {
      id: 'boundary-negative',
      status: 'n/a' as const,
      evidence: 'refactor only, nothing to check',
    };
    const flagged = judgeSieves({
      applicable: byId('boundary-negative'),
      rows: [naRow],
      mechanics: { behaviour: ['apps/web/src/a.tsx'] },
    });
    expect(flagged).toEqual([
      {
        code: 'sieve-gap-live-na',
        params: { sieve: 'boundary-negative', files: 'apps/web/src/a.tsx' },
      },
    ]);
    // Дифф из одних доков: контракт применим, n/a с причиной — принят.
    expect(
      judgeSieves({
        applicable: byId('contract-by-request'),
        rows: [{ id: 'contract-by-request', status: 'n/a', evidence: 'README wording only' }],
        mechanics: {},
      }),
    ).toEqual([]);
    // Не живое сито — n/a при коде по-прежнему принимается своими правилами.
    expect(
      judgeSieves({
        applicable: byId('branch-backend-stand'),
        rows: [{ id: 'branch-backend-stand', status: 'n/a', evidence: 'no stand needed here' }],
        mechanics: { behaviour: ['svc/main.go'] },
      }),
    ).toEqual([]);
  });

  it('liveNaIds: только живые сита, сданные n/a', () => {
    expect(
      liveNaIds([
        { id: 'contract-by-request', status: 'n/a', evidence: 'README wording only' },
        { id: 'browser-focus', status: 'pass', evidence },
        { id: 'branch-backend-stand', status: 'n/a', evidence: 'no backend change' },
      ]),
    ).toEqual(['contract-by-request']);
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
    // Механику панель проверяет сама — списком, без пункта и без строки отчёта.
    expect(deliver).not.toContain('[secrets]');
    expect(deliver).toMatch(/The panel itself checks[^\n]*secrets/);
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
