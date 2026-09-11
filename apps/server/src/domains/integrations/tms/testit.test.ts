import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { tmsClient } from './index.ts';
import type { TmsRunPush } from './types.ts';

/**
 * Test IT: адрес свой, заголовок `PrivateToken`, состав рана выборочный.
 *
 * Сеть подменена — живой установки Test IT у панели нет. Проверяется ровно то,
 * что от подмены не зависит: какой адрес собирается, что уходит в теле, что
 * повторная отправка НЕ заводит второй ран и что ключ не появляется ни в одном
 * тексте, который панель показывает человеку.
 */

interface Reply {
  status?: number;
  body?: unknown;
}

function stubApi(routes: [RegExp, Reply][]): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const found = routes.find(([pattern]) => pattern.test(String(url)));
    const reply = found?.[1] ?? { status: 404, body: { message: 'нет ручки' } };
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
      }),
    );
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const SETTINGS = {
  enabled: true,
  kind: 'testit' as const,
  baseUrl: 'https://testit.acme.local/',
  projectKey: 'PRJ-1',
  groupId: 'manual',
};

const TOKEN = 'TESTIT-SECRET';

const client = () => tmsClient(SETTINGS, TOKEN);

const run: ProjectTestRunRecord = {
  id: 'run-1',
  mode: 'run',
  actor: 'human',
  status: 'done',
  startedAt: '2026-09-10T10:00:00.000Z',
  branch: 'feature/login',
  results: [
    { pointId: 'p1', groupId: 'manual', caseId: 'ТК-1', status: 'passed' },
    {
      pointId: 'p2',
      groupId: 'manual',
      caseId: 'ТК-2',
      status: 'failed',
      note: 'форма не открылась',
    },
  ],
  summary: { total: 2, passed: 1, failed: 1, skipped: 0, blocked: 0 },
};

/** Пометки кейсов: `ТК-1` → `1001`, `ТК-2` → `1002`. */
const push: Omit<TmsRunPush, 'externalRunId'> = {
  run,
  keyOf: (result) => (result.caseId === 'ТК-1' ? '1001' : '1002'),
};

const WORK_ITEMS = [
  { id: 'guid-1', globalId: 1001, name: 'Вход' },
  { id: 'guid-2', globalId: 1002, name: 'Выход' },
  { id: 'guid-3', globalId: 1003, name: 'Чужой кейс' },
];

const RUN_RESULTS = {
  testResults: [
    { id: 'res-1', workItemGlobalId: 1001 },
    { id: 'res-2', testPoint: { workItemGlobalId: 1002 } },
  ],
};

describe('tms/testit: своя установка', () => {
  it('без адреса клиент не собирается — у своей установки его неоткуда взять', () => {
    expect(() => tmsClient({ ...SETTINGS, baseUrl: '  ' }, TOKEN)).toThrow(
      expect.objectContaining({ detail: 'baseUrl' }),
    );
    expect(() => tmsClient({ ...SETTINGS, baseUrl: 'testit.acme.local' }, TOKEN)).toThrow(/http/);
  });

  it('проверка связи: PrivateToken, /api/v2 и название проекта из ответа', async () => {
    const { calls } = stubApi([[/\/projects\//, { body: { name: 'Платформа компании' } }]]);

    await expect(client().ping()).resolves.toBe('Test IT, проект Платформа компании');
    expect(calls[0]!.url).toBe('https://testit.acme.local/api/v2/projects/PRJ-1');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      `PrivateToken ${TOKEN}`,
    );
  });

  it('кейсы приезжают с шагами; ключ — тот номер, который человек видит', async () => {
    stubApi([
      [/workItems\/search/, { body: [WORK_ITEMS[0]] }],
      [
        /workItems\/guid-1/,
        {
          body: {
            id: 'guid-1',
            globalId: 1001,
            name: 'Вход',
            preconditionSteps: [{ action: 'пользователь заведён' }],
            steps: [{ action: 'нажать «Войти»', expected: 'открылась форма', testData: 'demo' }],
          },
        },
      ],
    ]);

    const { cases } = await client().pullCases();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      key: '1001',
      title: 'Вход',
      precondition: 'пользователь заведён',
    });
    expect(cases[0]?.steps[0]).toEqual({
      action: 'нажать «Войти»',
      expected: 'открылась форма',
      data: 'demo',
    });
    expect(cases[0]?.url).toBe('https://testit.acme.local/projects/PRJ-1/tests/1001');
  });

  it('ран собирается ТОЛЬКО из кейсов прогона, а исходы ложатся по результатам', async () => {
    const { calls } = stubApi([
      [/workItems\/search/, { body: { items: WORK_ITEMS } }],
      [/testRuns\/byWorkItems/, { body: { id: 'tr-77' } }],
      [/testRuns\/tr-77/, { body: RUN_RESULTS }],
      [/testResults\//, { body: {} }],
    ]);

    const result = await client().pushRun(push);

    const created = calls.find((call) => call.url.includes('byWorkItems'));
    expect(JSON.parse(String(created!.init.body)).workItemIds).toEqual(['guid-1', 'guid-2']);

    const outcomes = calls
      .filter((call) => call.url.includes('/testResults/'))
      .map((call) => JSON.parse(String(call.init.body)));
    expect(outcomes).toEqual([
      { outcome: 'Passed', comment: '' },
      { outcome: 'Failed', comment: 'форма не открылась' },
    ]);

    expect(result).toMatchObject({ pushed: 2, runId: 'tr-77', reused: false });
    expect(result.url).toBe('https://testit.acme.local/projects/PRJ-1/testRuns/tr-77');
  });

  it('повторная отправка того же прогона не заводит второй ран', async () => {
    const { calls } = stubApi([
      [/testRuns\/tr-77/, { body: RUN_RESULTS }],
      [/testResults\//, { body: {} }],
    ]);

    const result = await client().pushRun({ ...push, externalRunId: 'tr-77' });

    expect(calls.some((call) => call.url.includes('byWorkItems'))).toBe(false);
    expect(calls.some((call) => call.url.includes('workItems/search'))).toBe(false);
    expect(result).toMatchObject({ pushed: 2, runId: 'tr-77', reused: true });
  });

  it('ни один кейс не помечен — наружу не уходит ни одного запроса', async () => {
    const { calls } = stubApi([]);

    await expect(client().pushRun({ run, keyOf: () => undefined })).resolves.toEqual({ pushed: 0 });
    expect(calls).toHaveLength(0);
  });

  it('пометки из чужого проекта — отказ словами, без ключа в тексте', async () => {
    stubApi([[/workItems\/search/, { body: [WORK_ITEMS[2]] }]]);

    await expect(client().pushRun(push)).rejects.toMatchObject({ detail: 'projectKey' });
    await expect(client().pushRun(push)).rejects.toThrow(/ни один кейс прогона не найден/);
  });

  /**
   * Находка M2 ревью Т9: потолок выборки срабатывал молча и одним запросом.
   * Проверяется через настоящие `pullCases`/`pushRun` — те же входы, что у
   * маршрута; подменена только сеть.
   */
  describe('потолок выборки называется вслух', () => {
    /** Страница ровно в 200 кейсов: столько панель просит одним запросом. */
    const fullPage = (from: number): { id: string; globalId: number; name: string }[] =>
      Array.from({ length: 200 }, (_, index) => ({
        id: `guid-${from + index}`,
        globalId: from + index,
        name: `Кейс ${from + index}`,
      }));

    it('кейсы за первой страницей всё-таки приезжают', async () => {
      const { calls } = stubApi([
        [/workItems\/search\?skip=0&/, { body: fullPage(1) }],
        [
          /workItems\/search\?skip=200&/,
          { body: [{ id: 'guid-201', globalId: 201, name: 'Хвост' }] },
        ],
        [/workItems\/guid-\d+$/, { body: { steps: [] } }],
      ]);

      const { cases, truncated } = await client().pullCases();
      expect(cases).toHaveLength(201);
      expect(cases.at(-1)?.key).toBe('201');
      // Неполная страница = конец списка, и обрезанным это не считается.
      expect(truncated).toBe(false);
      expect(calls.filter((call) => call.url.includes('workItems/search'))).toHaveLength(2);
    });

    it('упёрлись в потолок — это сказано, а не проглочено', async () => {
      stubApi([
        [/workItems\/search/, { body: fullPage(1) }],
        [/workItems\/guid-\d+$/, { body: { steps: [] } }],
      ]);

      const { cases, truncated } = await client().pullCases();
      expect(truncated).toBe(true);
      expect(cases).toHaveLength(2000);
    });

    it('кейс за потолком — отказ винит потолок, а не пометки «tms:»', async () => {
      // Все страницы полные и ни одного нужного кейса в них нет: ровно то, что
      // видит человек, чей проект больше потолка. Раньше он читал совет
      // «проверьте, что пометки из этого проекта» и шёл чинить не то.
      stubApi([[/workItems\/search/, { body: fullPage(5000) }]]);

      await expect(client().pushRun(push)).rejects.toThrow(/список кейсов проекта обрезан на 2000/);
      await expect(client().pushRun(push)).rejects.toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('пометки «tms:»') }),
      );
    });

    it('часть кейсов не нашлась — отправка идёт, но пропавшие названы', async () => {
      const { calls } = stubApi([
        [/workItems\/search/, { body: [WORK_ITEMS[0]] }],
        [/testRuns\/byWorkItems/, { body: { id: 'tr-77' } }],
        [/testRuns\/tr-77/, { body: RUN_RESULTS }],
        [/testResults\//, { body: {} }],
      ]);

      const result = await client().pushRun(push);
      // Ран заведён из того, что нашлось: терять весь прогон из-за одной
      // устаревшей пометки незачем.
      expect(
        JSON.parse(String(calls.find((c) => c.url.includes('byWorkItems'))!.init.body)).workItemIds,
      ).toEqual(['guid-1']);
      expect(result.missing).toEqual(['1002']);
    });

    it('все кейсы на месте — списку пропавших взяться неоткуда', async () => {
      stubApi([
        [/workItems\/search/, { body: WORK_ITEMS }],
        [/testRuns\/byWorkItems/, { body: { id: 'tr-77' } }],
        [/testRuns\/tr-77/, { body: RUN_RESULTS }],
        [/testResults\//, { body: {} }],
      ]);

      expect((await client().pushRun(push)).missing).toBeUndefined();
    });

    it('ран заведён — ключ сообщён сразу, до раскладки результатов', async () => {
      stubApi([
        [/workItems\/search/, { body: WORK_ITEMS }],
        [/testRuns\/byWorkItems/, { body: { id: 'tr-77' } }],
        // Раскладка результатов падает: ран на той стороне уже есть, и панель
        // обязана узнать о нём до отказа — иначе повторная отправка заведёт второй.
        [/testRuns\/tr-77/, { status: 500, body: { message: 'упало' } }],
      ]);

      const created: string[] = [];
      await expect(
        client().pushRun({ ...push, onRunCreated: (id) => created.push(id) }),
      ).rejects.toThrow();
      expect(created).toEqual(['tr-77']);
    });

    it('отправка в уже заведённый ран второй раз о нём не объявляет', async () => {
      stubApi([
        [/testRuns\/tr-77/, { body: RUN_RESULTS }],
        [/testResults\//, { body: {} }],
      ]);

      const created: string[] = [];
      await client().pushRun({
        ...push,
        externalRunId: 'tr-77',
        onRunCreated: (id) => created.push(id),
      });
      expect(created).toEqual([]);
    });
  });

  it('отказ сервера читается словами и не содержит ключа', async () => {
    stubApi([[/\/projects\//, { status: 401, body: { message: 'нет' } }]]);

    await expect(client().ping()).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(TOKEN) }),
    );
    await expect(client().ping()).rejects.toThrow(/токен отклонён/);
  });
});
