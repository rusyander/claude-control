import { mergeSieveRows, stampSieveRows, type SieveReportRow } from '@agentdeck/contracts/sieves';
import { describe, expect, it } from 'vitest';
import { matchText } from '../../../lib/server-texts/server-texts.ts';
import { normalizeQuoteText, quotesOf, taskSourceGaps } from './task-sources.ts';

/**
 * Источник строк следа задач (аудит g0 26.10, F3). Группа сдала `task-N` с доказательством
 * «файл в диффе», одну строку выдумала (task-1285 «правка с тестами» — кода не было) и через
 * 13 минут без коммита переписала её словами описания MR; доставка приняла обе, судя только
 * длину доказательства. Судья чистый: тексты задач, строки и время HEAD — входом.
 */

const TICKETS = [
  '# Tracker tickets of this group',
  '',
  '## PROJ-1285 — Фильтр по дате в журнале',
  'Status: В работе · type: Story',
  '',
  'Фильтр журнала принимает диапазон дат и сохраняет его в адресе страницы.',
  '',
  '## PROJ-1290 — Экспорт',
  'Not read by the panel: 403',
  '',
].join('\n');

const DESCRIPTION = '## Что сделано\nКнопка экспорта скрыта для роли «Наблюдатель».\n';

const row = (
  id: string,
  evidence: string,
  extra: Partial<SieveReportRow> = {},
): SieveReportRow => ({
  id,
  status: 'pass',
  evidence,
  ...extra,
});

const codes = (lines: readonly string[]) => lines.map((line) => matchText(line)?.messageCode);

const judge = (
  rows: SieveReportRow[],
  extra: {
    headCommittedAt?: string;
    sources?: Parameters<typeof taskSourceGaps>[0]['sources'];
  } = {},
) =>
  taskSourceGaps({
    rows,
    required: true,
    sources: extra.sources ?? { tickets: TICKETS, description: DESCRIPTION, texts: [] },
    ...(extra.headCommittedAt ? { headCommittedAt: extra.headCommittedAt } : {}),
  });

describe('task-sources: откуда пункт следа задач (g0 F3)', () => {
  it('цитата слово в слово из тикета, описания MR или задания — пробела нет; регистр, ё и знаки не мешают', () => {
    const gaps = judge(
      [
        row('task-1', 'PROJ-1285 «фильтр журнала принимает диапазон дат» — src/log/Filter.tsx:40'),
        row(
          'task-2',
          'MR description: «Кнопка экспорта скрыта для роли» — src/export/Button.tsx:12',
        ),
        row(
          'task-3',
          '«Сохраняет его в адресе страницы…» — src/log/url.ts:8, pnpm test → 4 passed',
        ),
      ],
      {
        sources: {
          tickets: TICKETS,
          description: DESCRIPTION,
          texts: ['Группа 2: проверить права на экспорт'],
        },
      },
    );
    expect(gaps).toEqual([]);
  });

  it('pass без цитаты пункта — «без источника»; короткое слово в кавычках цитатой не считается', () => {
    const gaps = judge([
      row('task-1', 'src/log/Filter.tsx in the diff, tests green'),
      row('task-2', '«done» — src/export/Button.tsx:12 and the test'),
    ]);
    expect(codes(gaps)).toEqual(['delivery-gap-task-unsourced', 'delivery-gap-task-unsourced']);
    expect(gaps[0]).toContain('task-1');
  });

  it('цитаты нет ни в тикетах, ни в задании, ни в описании MR — «цитата не найдена» с её текстом', () => {
    const gaps = judge([
      row('task-1', '«правка с тестами для фильтра журнала» — src/log/Filter.tsx:40'),
    ]);
    expect(codes(gaps)).toEqual(['delivery-gap-task-quote-unfound']);
    expect(gaps[0]).toContain('правка с тестами для фильтра журнала');
  });

  it('ключ задачи, текста которой у панели нет, — цитата принимается; ключ из файла — нет', () => {
    // PROJ-1290 в файле «Not read by the panel» — группа читала её в трекере сама.
    const notRead = judge([
      row('task-1', 'PROJ-1290 «экспорт в CSV с фильтрами» — src/export/csv.ts:3'),
    ]);
    expect(notRead).toEqual([]);
    const outside = judge([row('task-2', 'PROJ-77 «миграция индекса заказов» — db/017.sql:1')]);
    expect(outside).toEqual([]);
    const covered = judge([
      row('task-3', 'PROJ-1285 «экспорт в CSV с фильтрами» — src/export/csv.ts:3'),
    ]);
    expect(codes(covered)).toEqual(['delivery-gap-task-quote-unfound']);
  });

  it('панель не держит ни одного текста задач — хватает цитаты, сверять не с чем', () => {
    const gaps = judge([row('task-1', '«что угодно длиной от десяти» — src/a.ts:1')], {
      sources: {},
    });
    expect(gaps).toEqual([]);
  });

  it('fail, n/a, не task-строки и короткое доказательство — не судятся; без taskTrace — ничего', () => {
    const rows = [
      row('task-1', 'src/a.ts in the diff', { status: 'fail' }),
      row('task-2', 'other group owns it', { status: 'n/a' }),
      row('browser-focus', 'checked by hand, all fine'),
      row('task-3', 'ok'),
    ];
    expect(judge(rows)).toEqual([]);
    expect(
      taskSourceGaps({
        rows: [row('task-1', 'src/log/Filter.tsx in the diff, tests green')],
        required: false,
        sources: {},
      }),
    ).toEqual([]);
  });

  describe('доказательство переписано без коммита', () => {
    const before =
      'PROJ-1285 «фильтр журнала принимает диапазон дат» — src/log/Filter.tsx:40 + test';
    const now = 'PROJ-1285 «фильтр журнала принимает диапазон дат» — по описанию MR, кода нет';
    const rewritten = row('task-1', now, {
      at: '2026-10-26T15:13:00Z',
      rewrote: { evidence: before, at: '2026-10-26T15:00:00Z' },
    });

    it('HEAD не новее прежней сдачи, смысл другой — пробел с обоими текстами', () => {
      const gaps = judge([rewritten], { headCommittedAt: '2026-10-26T14:50:00Z' });
      expect(codes(gaps)).toEqual(['delivery-gap-task-rewritten']);
      expect(gaps[0]).toContain('Filter.tsx:40 + test');
      expect(gaps[0]).toContain('кода нет');
    });

    /**
     * Аудит g9 27.10 (R4): после сжатия группа пересдала нетронутые строки своими словами,
     * местная сверка (`tests-cli delivery --answer`) кладёт ответ поверх строк панели и
     * осталась красной, текст звал «повторить следующим ответом» — группа закончила ход,
     * и понадобился второй раунд. Слияние то же, что у сверки и у панели после хода.
     */
    it('пересдана своими словами — пробел зовёт убрать строку; без неё или слово в слово — пробела нет в том же ходе', () => {
      const stored = [row('task-1', before, { at: '2026-10-26T15:00:00Z' })];
      const head = { headCommittedAt: '2026-10-26T14:50:00Z' };
      const answer = (rows: SieveReportRow[]) =>
        judge(mergeSieveRows(stored, stampSieveRows(rows, '2026-10-26T15:13:00Z')), head);

      const retyped = answer([row('task-1', now)]);
      expect(codes(retyped)).toEqual(['delivery-gap-task-rewritten']);
      expect(retyped[0]).toContain('уберите эту строку из ответа');
      expect(answer([])).toEqual([]);
      expect(answer([row('task-1', before)])).toEqual([]);
    });

    it('после прежней сдачи был коммит — честная правка, пробела нет', () => {
      expect(judge([rewritten], { headCommittedAt: '2026-10-26T15:05:00Z' })).toEqual([]);
    });

    it('прежнее доказательство было без источника — переписать его и просили, пробела нет', () => {
      const fixed = row('task-1', now, {
        rewrote: { evidence: 'src/log/Filter.tsx in the diff', at: '2026-10-26T15:00:00Z' },
      });
      expect(judge([fixed], { headCommittedAt: '2026-10-26T14:50:00Z' })).toEqual([]);
    });

    it('сменились только номер прогона, числа и время — тот же пункт, пробела нет', () => {
      const rerun = row(
        'task-1',
        'PROJ-1285 «фильтр журнала принимает диапазон дат» — tests run 3f9c2a1b-77aa-4c1d-9e0f-1234567890ab → 14 passed at 15:12',
        {
          rewrote: {
            evidence:
              'PROJ-1285 «фильтр журнала принимает диапазон дат» — tests run 0a1b2c3d → 12 passed at 15:01',
            at: '2026-10-26T15:00:00Z',
          },
        },
      );
      expect(judge([rerun], { headCommittedAt: '2026-10-26T14:50:00Z' })).toEqual([]);
    });

    it('сменился только однобуквенный предлог — тот же пункт, пробела нет', () => {
      const quote = 'PROJ-1285 «фильтр журнала принимает диапазон дат» — ';
      const preposition = row('task-1', `${quote}go test ./internal/... inst-auth → ok`, {
        rewrote: {
          evidence: `${quote}\`go test ./internal/...\` в inst-auth → ok`,
          at: '2026-10-26T15:00:00Z',
        },
      });
      expect(judge([preposition], { headCommittedAt: '2026-10-26T14:50:00Z' })).toEqual([]);
    });

    it('общее начало длиннее показа — обе строки видны с места расхождения', () => {
      const shared =
        'PROJ-1285 «фильтр журнала принимает диапазон дат» — src/log/Filter.tsx, ' +
        'src/log/FilterRange.tsx, src/log/useRange.ts, src/log/range.test.ts, ' +
        'src/log/Filter.stories.tsx, src/log/index.ts: ';
      const long = row('task-1', `${shared}по описанию MR, кода нет`, {
        rewrote: { evidence: `${shared}unit tests green`, at: '2026-10-26T15:00:00Z' },
      });
      const gaps = judge([long], { headCommittedAt: '2026-10-26T14:50:00Z' });
      expect(codes(gaps)).toEqual(['delivery-gap-task-rewritten']);
      expect(gaps[0]).toContain('unit tests green');
      expect(gaps[0]).toContain('кода нет');
    });

    it('время HEAD неизвестно — переписанное не судится', () => {
      expect(judge([rewritten])).toEqual([]);
    });
  });

  it('цитата режется многоточием на части, каждая ищется отдельно', () => {
    expect(quotesOf('«Фильтр журнала принимает … в адресе страницы» и "ok"')).toEqual([
      ['фильтр журнала принимает', 'в адресе страницы'],
    ]);
    expect(normalizeQuoteText('Ёлка — «ЗЕЛЁНАЯ»!')).toBe('елка зеленая');
  });

  it('вложенные «ёлочки» — одна цитата целиком, и пункт тикета находится (g1 26.10)', () => {
    const evidence = 'GOR-1 «Кнопка «Сохранить» не активна без прав» — Form.tsx:40';
    expect(quotesOf(evidence)).toEqual([['кнопка сохранить не активна без прав']]);
    // Порядок — как в тексте: прямые кавычки до «ёлочек» идут первыми.
    expect(quotesOf('"первая цитата тут" и «вторая «вложенная» цитата»')).toEqual([
      ['первая цитата тут'],
      ['вторая вложенная цитата'],
    ]);
  });
});

/**
 * F5 (g1 26.10): строка task-1669 прошла, потому что единственной цитатой в ней была метка
 * инструмента «qa-gl244-deepwiki: ask_wiki_question» — она есть в тикете, но пунктом не является.
 * И цитата судилась по всем текстам разом: фраза соседнего тикета «доказывала» чужой пункт.
 */
describe('task-sources: метка вместо пункта и цитата из чужого тикета (g1 F5)', () => {
  const TWO = [
    TICKETS,
    '## PROJ-1300 — Права на удаление',
    'Status: В работе',
    '',
    'Кнопка удаления видна только администратору; вызов qa-gl244-deepwiki: ask_wiki_question.',
    '',
  ].join('\n');
  const sources = { tickets: TWO, description: DESCRIPTION, texts: [] };

  it('единственная цитата — метка инструмента из тикета — пробел «метка», с её текстом', () => {
    const gaps = judge(
      [row('task-1', 'PROJ-1300 «qa-gl244-deepwiki: ask_wiki_question» — src/a.ts:1')],
      { sources },
    );
    expect(codes(gaps)).toEqual(['delivery-gap-task-quote-label']);
    expect(gaps[0]).toContain('qa-gl244-deepwiki: ask_wiki_question');
  });

  it('метка рядом с цитатой самого пункта — судится пункт, пробела нет', () => {
    const gaps = judge(
      [
        row(
          'task-1',
          'PROJ-1300 «Кнопка удаления видна только администратору» через «qa-gl244-deepwiki: ask_wiki_question» — src/a.ts:1',
        ),
      ],
      { sources },
    );
    expect(gaps).toEqual([]);
  });

  it('цитата из раздела соседнего тикета под ключом другой задачи — «цитата не найдена»', () => {
    const foreign = judge(
      [row('task-1', 'PROJ-1285 «Кнопка удаления видна только администратору» — src/a.ts:1')],
      { sources },
    );
    expect(codes(foreign)).toEqual(['delivery-gap-task-quote-unfound']);
    const own = judge(
      [row('task-2', 'PROJ-1300 «Кнопка удаления видна только администратору» — src/a.ts:1')],
      { sources },
    );
    expect(own).toEqual([]);
  });

  it('описание MR: пункт из раздела «Что сделано» — источник, из раздела проверок — нет', () => {
    const description = [
      '## Что сделано',
      'Кнопка экспорта скрыта для роли «Наблюдатель».',
      '## Проверки на финальном дереве',
      'pnpm test прошёл на ветке целиком',
    ].join('\n');
    const gaps = judge(
      [
        row('task-1', 'MR: «Кнопка экспорта скрыта для роли» — src/export/Button.tsx:12'),
        row('task-2', 'MR: «pnpm test прошёл на ветке целиком» — src/export/Button.tsx:12'),
      ],
      { sources: { tickets: TICKETS, description, texts: [] } },
    );
    expect(codes(gaps)).toEqual(['delivery-gap-task-quote-unfound']);
    expect(gaps[0]).toContain('task-2');
  });
});
