import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudePaths } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import { createZip } from '../../lib/zip.ts';
import { compose, createTelegramNotifier, sendTelegramMessage } from '../notify/telegram.ts';
import { fetchCiReport } from './ci.ts';
import {
  commentForgeIssue,
  commentMergeRequest,
  commentMergeRequestByUrl,
  createForgeIssue,
  forgeAccessForUrl,
  parseMergeRequestUrl,
  readMergeRequestByUrl,
  toForgeAccess,
  toForgeIdentity,
  whoAmI,
} from './forge.ts';
import {
  ATLASSIAN_MCP_ID,
  activateAtlassianMcp,
  atlassianMcpScript,
  isAtlassianMcpRegistered,
  registerAtlassianMcp,
  unregisterAtlassianMcp,
} from './mcp-server.ts';
import { writeLink } from './links.ts';
import { tmsClient } from './tms/index.ts';
import { externalKeys, keyFromTags, keyLookup, sourceTag } from './tms/types.ts';

/**
 * Всё остальное, что уходит с этой машины: форджи по токену, отчёты CI,
 * тест-менеджмент, Telegram и собственный MCP-переходник.
 *
 * Сеть подменена везде. Проверяем три вещи: адрес и заголовки собираются по
 * виду системы, отказ читается словами, а секрет не появляется ни в одном
 * тексте, который панель показывает или пишет.
 */

interface Reply {
  status?: number;
  body?: unknown;
  bytes?: Buffer;
}

function stubApi(routes: [RegExp, Reply][]): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const found = routes.find(([pattern]) => pattern.test(String(url)));
    const reply = found?.[1] ?? { status: 404, body: { message: 'нет ручки' } };
    if (reply.bytes) {
      return Promise.resolve(new Response(reply.bytes, { status: reply.status ?? 200 }));
    }
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

describe('domains/integrations/forge: дефекты по токену', () => {
  const github = toForgeAccess(
    { enabled: true, kind: 'github', baseUrl: '', repo: 'acme/panel' },
    'GH-SECRET',
  );
  const gitlab = toForgeAccess(
    { enabled: true, kind: 'gitlab', baseUrl: 'https://git.acme.local', repo: 'team/panel' },
    'GL-SECRET',
  );

  it('корень API: у github.com отдельный хост, у Enterprise и GitLab — свой', () => {
    expect(github.api).toBe('https://api.github.com');
    expect(gitlab.api).toBe('https://git.acme.local/api/v4');
    expect(
      toForgeIdentity({ enabled: true, kind: 'github', baseUrl: 'https://gh.acme', repo: '' }, 't')
        .api,
    ).toBe('https://gh.acme/api/v3');
  });

  it('не выбран вид или нет репозитория — 400 с именем поля', () => {
    expect(() => toForgeAccess({ enabled: true, kind: '', baseUrl: '', repo: 'a/b' }, 't')).toThrow(
      expect.objectContaining({ detail: 'kind' }),
    );
    expect(() =>
      toForgeAccess({ enabled: true, kind: 'github', baseUrl: '', repo: '' }, 't'),
    ).toThrow(expect.objectContaining({ detail: 'repo' }));
  });

  it('проверка связи не требует репозитория — ключ сохраняют раньше проекта', async () => {
    stubApi([[/api\.github\.com\/user/, { body: { login: 'olga' } }]]);
    await expect(
      whoAmI(toForgeIdentity({ enabled: true, kind: 'github', baseUrl: '', repo: '' }, 't')),
    ).resolves.toBe('olga');
  });

  it('заголовок авторизации у каждого свой', async () => {
    const gh = stubApi([[/user/, { body: { login: 'olga' } }]]);
    await whoAmI(github);
    expect((gh.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer GH-SECRET',
    );

    const gl = stubApi([[/user/, { body: { username: 'olga' } }]]);
    await whoAmI(gitlab);
    expect((gl.calls[0]!.init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe(
      'GL-SECRET',
    );
  });

  it('задача GitHub: путь и поля свои, ссылка возвращается наружу', async () => {
    const { calls } = stubApi([
      [/repos\/acme\/panel\/issues/, { body: { html_url: 'https://gh/1', number: 1 } }],
    ]);
    await expect(createForgeIssue(github, 'Падает вход', 'шаги')).resolves.toEqual({
      url: 'https://gh/1',
      number: 1,
    });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      title: 'Падает вход',
      body: 'шаги',
    });
  });

  it('задача GitLab: путь проекта кодируется целиком, тело зовётся description', async () => {
    const { calls } = stubApi([
      [/projects\/team%2Fpanel\/issues/, { body: { web_url: 'https://gl/2', iid: 2 } }],
    ]);
    await expect(createForgeIssue(gitlab, 'Падает', 'шаги')).resolves.toMatchObject({ number: 2 });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      title: 'Падает',
      description: 'шаги',
    });
  });

  it('комментарий к задаче и к запросу на слияние идут по разным путям у GitLab', async () => {
    const { calls } = stubApi([[/./, { body: {} }]]);
    await commentForgeIssue(gitlab, 5, 'проверено');
    await commentMergeRequest(gitlab, 5, 'прогон зелёный');
    expect(calls[0]!.url).toContain('/issues/5/notes');
    expect(calls[1]!.url).toContain('/merge_requests/5/notes');
  });

  it('пустой заголовок и пустой комментарий не уходят наружу', async () => {
    const { calls } = stubApi([]);
    await expect(createForgeIssue(github, '   ', 'тело')).rejects.toMatchObject({
      detail: 'title',
    });
    await expect(commentForgeIssue(github, 1, ' ')).rejects.toMatchObject({ detail: 'body' });
    expect(calls).toHaveLength(0);
  });

  it('отказ форджа читается словами, а не кодом', async () => {
    stubApi([[/./, { status: 401, body: { message: 'bad token' } }]]);
    await expect(createForgeIssue(github, 'x', 'y')).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('токен отклонён'),
    });
  });
});

/**
 * Ревью чужого MR по ссылке (Т7). Ссылку даёт человек словами, а по разобранному
 * адресу панель заводит копию на чужой ветке и пишет в чужое обсуждение —
 * поэтому «не разобрал» здесь обязано быть отказом, а не догадкой.
 */
describe('domains/integrations/forge: запрос на слияние по ссылке', () => {
  it('GitLab: подгруппы, разделитель `-`, хвост адреса — всё это одна и та же ссылка', () => {
    const expected = {
      kind: 'gitlab',
      site: 'https://git.acme.local',
      repo: 'team/sub/app',
      number: 42,
    };

    expect(parseMergeRequestUrl('https://git.acme.local/team/sub/app/-/merge_requests/42')).toEqual(
      expected,
    );
    expect(
      parseMergeRequestUrl(
        '  https://git.acme.local/team/sub/app/-/merge_requests/42/diffs#note_7 ',
      ),
    ).toEqual(expected);
    // Старая форма без разделителя — такие ссылки живут в задачах годами.
    expect(parseMergeRequestUrl('https://git.acme.local/team/sub/app/merge_requests/42')).toEqual(
      expected,
    );
  });

  it('GitHub: и адрес браузера, и вид из API', () => {
    expect(parseMergeRequestUrl('https://github.com/acme/panel/pull/7')).toEqual({
      kind: 'github',
      site: 'https://github.com',
      repo: 'acme/panel',
      number: 7,
    });
    expect(parseMergeRequestUrl('https://github.com/acme/panel/pulls/7')).toMatchObject({
      number: 7,
    });
  });

  it('не ссылка на MR — отказ, а не догадка', () => {
    for (const url of [
      'https://git.acme.local/team/app/-/issues/42',
      'https://git.acme.local/team/app/-/merge_requests/абв',
      'https://git.acme.local/team/app/-/merge_requests/0',
      'https://github.com/acme/panel',
      'file:///etc/passwd',
      'не ссылка вовсе',
      '',
    ]) {
      expect(parseMergeRequestUrl(url)).toBeUndefined();
    }
  });

  it('доступ берётся из САМОЙ ссылки: репозиторий настройки увёл бы запрос не туда', () => {
    expect(forgeAccessForUrl('https://git.acme.local/team/app/-/merge_requests/42', 'T')).toEqual({
      kind: 'gitlab',
      api: 'https://git.acme.local/api/v4',
      site: 'https://git.acme.local',
      repo: 'team/app',
      token: 'T',
    });
    expect(forgeAccessForUrl('https://github.com/acme/panel/pull/7', 'T')).toMatchObject({
      api: 'https://api.github.com',
      repo: 'acme/panel',
    });
    expect(forgeAccessForUrl('https://github.com/acme/panel', 'T')).toBeUndefined();
  });

  it('ветка копии — та, что назвал фордж; закрытый MR виден по состоянию', async () => {
    const { calls } = stubApi([
      [
        /merge_requests\/42/,
        {
          body: {
            title: 'Вход',
            state: 'opened',
            source_branch: 'feature/login',
            target_branch: 'main',
            web_url: 'https://git.acme.local/mr/42',
          },
        },
      ],
    ]);

    await expect(
      readMergeRequestByUrl('https://git.acme.local/team/app/-/merge_requests/42', 'T'),
    ).resolves.toEqual({
      branch: 'feature/login',
      targetBranch: 'main',
      title: 'Вход',
      url: 'https://git.acme.local/mr/42',
      state: 'open',
    });
    expect(calls[0]!.url).toBe(
      'https://git.acme.local/api/v4/projects/team%2Fapp/merge_requests/42',
    );
  });

  it('GitHub называет ветку своими полями, а `open` у него без хвоста', async () => {
    stubApi([
      [
        /pulls\/7/,
        {
          body: {
            title: 'Шапка',
            state: 'open',
            head: { ref: 'feature/header' },
            base: { ref: 'main' },
            html_url: 'https://gh/7',
          },
        },
      ],
    ]);

    await expect(
      readMergeRequestByUrl('https://github.com/acme/panel/pull/7', 'T'),
    ).resolves.toMatchObject({ branch: 'feature/header', state: 'open' });
  });

  it('MR без ветки — отказ: копию отводить не от чего', async () => {
    stubApi([[/merge_requests\/42/, { body: { title: 'Вход', state: 'opened' } }]]);

    await expect(
      readMergeRequestByUrl('https://git.acme.local/team/app/-/merge_requests/42', 'T'),
    ).rejects.toMatchObject({ message: expect.stringContaining('не назвал ветку') });
  });

  it('чужая ссылка не читается и в неё не пишут', async () => {
    const { calls } = stubApi([]);

    await expect(
      readMergeRequestByUrl('https://github.com/acme/panel', 'T'),
    ).resolves.toBeUndefined();
    await expect(
      commentMergeRequestByUrl('https://github.com/acme/panel', 'T', 'текст'),
    ).rejects.toMatchObject({ detail: 'url' });
    expect(calls).toHaveLength(0);
  });

  it('комментарий уходит в обсуждение того MR, что в ссылке', async () => {
    const { calls } = stubApi([[/./, { body: {} }]]);

    await commentMergeRequestByUrl(
      'https://git.acme.local/team/app/-/merge_requests/42',
      'T',
      '**Замечания ревью (1)**',
    );

    expect(calls[0]!.url).toBe(
      'https://git.acme.local/api/v4/projects/team%2Fapp/merge_requests/42/notes',
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ body: '**Замечания ревью (1)**' });
  });
});

describe('domains/integrations/ci: отчёт последнего прогона', () => {
  const junit = '<testsuite><testcase name="вход"/></testsuite>';

  it('GitHub: прогон → артефакт → zip → XML внутри', async () => {
    const zip = createZip(
      [
        { path: 'trace.txt', data: Buffer.from('шум') },
        { path: 'reports/junit.xml', data: Buffer.from(junit) },
      ],
      new Date('2026-09-07T00:00:00Z'),
    );
    stubApi([
      [
        /actions\/runs\?/,
        { body: { workflow_runs: [{ id: 42, name: 'ci', display_title: 'CI' }] } },
      ],
      [/runs\/42\/artifacts/, { body: { artifacts: [{ id: 7, name: 'reports' }] } }],
      [/artifacts\/7\/zip/, { bytes: zip }],
    ]);
    const report = await fetchCiReport(
      { enabled: true, kind: 'github', repo: 'acme/panel', workflow: '', artifact: '' },
      'GH',
    );
    expect(report.content).toBe(junit);
    expect(report.source).toContain('#42');
  });

  it('GitLab: путь к XML внутри артефактов берётся напрямую, без архива', async () => {
    const { calls } = stubApi([
      [/pipelines\?/, { body: [{ id: 9 }] }],
      [
        /pipelines\/9\/jobs/,
        { body: [{ id: 3, name: 'test', artifacts_file: { filename: 'a' } }] },
      ],
      [/jobs\/3\/artifacts\/junit\.xml/, { bytes: Buffer.from(junit) }],
    ]);
    const report = await fetchCiReport(
      { enabled: true, kind: 'gitlab', repo: 'team/panel', workflow: '', artifact: 'junit.xml' },
      'GL',
      { baseUrl: 'https://git.acme.local' },
    );
    expect(report.content).toBe(junit);
    expect(calls.at(-1)!.url).toContain('https://git.acme.local/api/v4');
  });

  it('нет завершённых прогонов — понятная причина, а не пустой отчёт', async () => {
    stubApi([[/actions\/runs\?/, { body: { workflow_runs: [] } }]]);
    await expect(
      fetchCiReport(
        { enabled: true, kind: 'github', repo: 'acme/panel', workflow: '', artifact: '' },
        'GH',
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('ни одного завершённого прогона') });
  });

  it('в артефакте нет XML — называем имя, которого не хватило', async () => {
    const zip = createZip(
      [{ path: 'shot.png', data: Buffer.from('png') }],
      new Date('2026-09-07T00:00:00Z'),
    );
    stubApi([
      [/actions\/runs\?/, { body: { workflow_runs: [{ id: 1 }] } }],
      [/artifacts$/, { body: { artifacts: [{ id: 2, name: 'a' }] } }],
      [/artifacts\/2\/zip/, { bytes: zip }],
    ]);
    await expect(
      fetchCiReport(
        { enabled: true, kind: 'github', repo: 'acme/panel', workflow: '', artifact: 'junit.xml' },
        'GH',
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('junit.xml') });
  });

  it('не выбрана система — 400 с именем поля', async () => {
    await expect(
      fetchCiReport({ enabled: true, kind: '', repo: 'a/b', workflow: '', artifact: '' }, 'T'),
    ).rejects.toMatchObject({ detail: 'kind' });
  });
});

describe('domains/integrations/tms: Zephyr и Xray за одним интерфейсом', () => {
  it('не выбрана система или нет токена — честное «не подключено»', () => {
    expect(() =>
      tmsClient(
        { enabled: false, kind: 'zephyr', baseUrl: '', projectKey: 'GOR', groupId: '' },
        'T',
      ),
    ).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(() =>
      tmsClient({ enabled: true, kind: '', baseUrl: '', projectKey: 'GOR', groupId: '' }, 'T'),
    ).toThrow(/не выбрана система/);
    expect(() =>
      tmsClient({ enabled: true, kind: 'zephyr', baseUrl: '', projectKey: '', groupId: '' }, 'T'),
    ).toThrow(expect.objectContaining({ detail: 'projectKey' }));
  });

  it('Zephyr: кейсы приезжают с шагами, проверка связи — одна страница', async () => {
    const { calls } = stubApi([
      [
        /testcases/,
        {
          body: {
            values: [
              {
                key: 'GOR-T1',
                name: 'Вход',
                objective: 'проверить вход',
                testScript: { steps: [{ description: 'нажать', expectedResult: 'открылось' }] },
              },
            ],
          },
        },
      ],
    ]);
    const client = tmsClient(
      { enabled: true, kind: 'zephyr', baseUrl: '', projectKey: 'GOR', groupId: '' },
      'ZEPHYR-SECRET',
    );
    await expect(client.ping()).resolves.toContain('GOR');
    expect(calls[0]!.url).toContain('maxResults=1');

    const { cases } = await client.pullCases();
    expect(cases[0]).toMatchObject({
      key: 'GOR-T1',
      title: 'Вход',
      precondition: 'проверить вход',
    });
    expect(cases[0]?.steps[0]).toEqual({
      action: 'нажать',
      expected: 'открылось',
      data: undefined,
    });
  });

  it('Zephyr: кейс без пометки tms: пропускается — придумывать связь нельзя', async () => {
    stubApi([
      [/testcycles/, { body: { key: 'GOR-C1' } }],
      [/testexecutions/, { body: {} }],
    ]);
    const client = tmsClient(
      { enabled: true, kind: 'zephyr', baseUrl: '', projectKey: 'GOR', groupId: '' },
      'Z',
    );
    const result = await client.pushRun({
      run: {
        id: 'r1',
        mode: 'run',
        actor: 'agent',
        status: 'done',
        startedAt: '2026-09-07T10:00:00.000Z',
        results: [
          { pointId: 'g/c1', groupId: 'g', caseId: 'c1', status: 'failed', note: 'упал' },
          { pointId: 'g/c2', groupId: 'g', caseId: 'c2', status: 'passed' },
        ],
        summary: { total: 2, passed: 1, failed: 1, skipped: 0, blocked: 0 },
      },
      keyOf: (result) => (result.caseId === 'c1' ? 'GOR-T1' : undefined),
    });
    expect(result.pushed).toBe(1);
  });

  it('Xray: пара разбирается из одного поля, JWT берётся на время операции', async () => {
    const { calls } = stubApi([
      [/authenticate/, { body: 'jwt-token' }],
      [/import\/execution/, { body: { self: 'https://xray/exec/1' } }],
    ]);
    const client = tmsClient(
      { enabled: true, kind: 'xray', baseUrl: '', projectKey: 'GOR', groupId: '' },
      'id:secret',
    );
    const result = await client.pushRun({
      run: {
        id: 'r1',
        mode: 'run',
        actor: 'agent',
        status: 'done',
        startedAt: '2026-09-07T10:00:00.000Z',
        results: [{ pointId: 'g/c1', groupId: 'g', caseId: 'c1', status: 'failed' }],
        summary: { total: 1, passed: 0, failed: 1, skipped: 0, blocked: 0 },
      },
      keyOf: () => 'PRJ-1',
    });
    expect(result).toMatchObject({ pushed: 1, url: 'https://xray/exec/1', reused: false });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      client_id: 'id',
      client_secret: 'secret',
    });
  });

  it('Xray: токен без двоеточия — 400 с объяснением формы, а не 401 из чужого API', async () => {
    stubApi([]);
    const client = tmsClient(
      { enabled: true, kind: 'xray', baseUrl: '', projectKey: 'GOR', groupId: '' },
      'один-кусок',
    );
    await expect(client.ping()).rejects.toMatchObject({ detail: 'token' });
  });

  it('пометка источника ходит туда и обратно', () => {
    expect(sourceTag('GOR-T1')).toBe('tms:GOR-T1');
    expect(keyFromTags(['smoke', 'tms:GOR-T1'])).toBe('GOR-T1');
    expect(keyFromTags(undefined)).toBeUndefined();

    const keys = externalKeys([
      {
        id: 'g',
        title: 'Группа',
        file: '.agent/tests/g.tests.json',
        cases: [
          {
            id: 'c1',
            type: 'case',
            title: 'a',
            steps: [],
            status: 'unknown',
            source: 'human',
            tags: ['tms:GOR-T1'],
          },
          { id: 'c2', type: 'case', title: 'b', steps: [], status: 'unknown', source: 'human' },
        ],
      },
    ]);
    const lookup = keyLookup(keys);
    expect(lookup({ pointId: 'g/c1', groupId: 'g', caseId: 'c1', status: 'passed' })).toBe(
      'GOR-T1',
    );
    expect(
      lookup({ pointId: 'g/c2', groupId: 'g', caseId: 'c2', status: 'passed' }),
    ).toBeUndefined();
  });
});

describe('domains/notify/telegram', () => {
  const BOT = '7654321:AAH-SUPER-SECRET';

  it('текст уведомления называет событие и папку проекта — и только их', () => {
    expect(compose({ kind: 'done', chatId: 'c', projectPath: 'C:/work/panel' })).toBe(
      '✅ Работа закончена — panel',
    );
    expect(compose({ kind: 'error', chatId: 'c' })).toContain('Домашний чат');
    expect(compose({ kind: 'permission', chatId: 'c', toolName: 'Bash' })).toContain('Bash');
    expect(compose({ kind: 'question', chatId: 'c' })).toContain('вопрос');
    expect(compose({ kind: 'testFailed', chatId: 'c', failed: 3, total: 10 })).toBe(
      '🔴 Тесты провалены (3 из 10) — Домашний чат',
    );
  });

  it('ТОКЕН БОТА не попадает в отказ, хотя он часть адреса', async () => {
    stubApi([[/sendMessage/, { status: 400, body: { description: `bot${BOT} not found` } }]]);
    let caught: unknown;
    try {
      await sendTelegramMessage(BOT, '@qa', 'привет');
    } catch (error) {
      caught = error;
    }
    expect(JSON.stringify(caught)).not.toContain('AAH-SUPER-SECRET');
  });

  it('выключено, нет чата или событие не подписано — ни одного запроса', () => {
    const { calls } = stubApi([[/./, { body: { ok: true } }]]);
    const off = createTelegramNotifier({
      settings: () => ({ enabled: false, chatId: '@qa', events: ['runDone'] }),
      token: () => BOT,
    });
    off({ kind: 'done', chatId: 'c' });

    const unsubscribed = createTelegramNotifier({
      settings: () => ({ enabled: true, chatId: '@qa', events: ['runError'] }),
      token: () => BOT,
    });
    unsubscribed({ kind: 'done', chatId: 'c' });

    const noToken = createTelegramNotifier({
      settings: () => ({ enabled: true, chatId: '@qa', events: ['runDone'] }),
      token: () => undefined,
    });
    noToken({ kind: 'done', chatId: 'c' });

    expect(calls).toHaveLength(0);
  });

  it('подписанное событие уходит, а неудача отправки никого не роняет', async () => {
    const { calls } = stubApi([[/sendMessage/, { status: 500 }]]);
    const errors: unknown[] = [];
    const notify = createTelegramNotifier({
      settings: () => ({ enabled: true, chatId: '@qa', events: ['testFailed'] }),
      token: () => BOT,
      onError: (error) => errors.push(error),
    });
    notify({ kind: 'testFailed', chatId: 'c', failed: 2 });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ chat_id: '@qa' });
  });
});

describe('domains/integrations/mcp-server: переходник в конфиге CLI', () => {
  let dir: string;
  let mcpConfig: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
    mcpConfig = join(dir, '.claude.json');
    writeFileSync(mcpConfig, '{}', 'utf8');
    store = new AppStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const options = (): { mcpConfigPath: string; selfBaseUrl: string } => ({
    mcpConfigPath: mcpConfig,
    selfBaseUrl: 'http://127.0.0.1:5178',
  });

  it('имя записи с префиксом панели — чужой «atlassian» не затирается', () => {
    expect(ATLASSIAN_MCP_ID).toBe('agentdeck-atlassian');
    expect(atlassianMcpScript()).toContain('atlassian.mjs');
  });

  it('в запись уходит АДРЕС ПАНЕЛИ и ничего больше — токена Atlassian там нет', () => {
    registerAtlassianMcp(options());
    const raw = readFileSync(mcpConfig, 'utf8');
    expect(raw).toContain('AGENTDECK_URL');
    expect(raw).toContain('atlassian.mjs');
    expect(raw).not.toMatch(/token/i);
    expect(isAtlassianMcpRegistered(mcpConfig)).toBe(true);
  });

  it('повторная регистрация обновляет запись, а не отказывает', () => {
    registerAtlassianMcp(options());
    expect(() =>
      registerAtlassianMcp({ ...options(), selfBaseUrl: 'http://127.0.0.1:6000' }),
    ).not.toThrow();
    expect(readFileSync(mcpConfig, 'utf8')).toContain('6000');
  });

  it('снятие несуществующей записи — не ошибка: кнопку могли нажать дважды', () => {
    expect(unregisterAtlassianMcp(options())).toBe(false);
    registerAtlassianMcp(options());
    expect(unregisterAtlassianMcp(options())).toBe(true);
    expect(isAtlassianMcpRegistered(mcpConfig)).toBe(false);
  });

  it('включение на старте прогона: без привязки и без записи не делается ничего', () => {
    const deps = { paths: { mcpConfig } as ClaudePaths, store };
    expect(activateAtlassianMcp(deps, store, join(dir, 'repo'))).toBe(false);

    writeLink(store, join(dir, 'repo'), undefined, { jiraIssueKey: 'PRJ-1' });
    // Привязка есть, но переходник не зарегистрирован — включать нечего.
    expect(activateAtlassianMcp(deps, store, join(dir, 'repo'))).toBe(false);
  });

  it('выключенный вручную переходник включается прогоном и больше не выключается', () => {
    const deps = { paths: { mcpConfig } as ClaudePaths, store };
    const project = join(dir, 'repo');
    writeLink(store, project, undefined, { jiraIssueKey: 'PRJ-1' });
    registerAtlassianMcp(options());
    store.setEnabled('mcp', ATLASSIAN_MCP_ID, false);

    expect(activateAtlassianMcp(deps, store, project)).toBe(true);
    expect(store.isDisabled('mcp', ATLASSIAN_MCP_ID)).toBe(false);
    // Второй прогон ничего не меняет: включать уже нечего.
    expect(activateAtlassianMcp(deps, store, project)).toBe(false);
  });

  it('осечка включения не роняет прогон — она уходит в колбэк', () => {
    const errors: unknown[] = [];
    const broken = {
      paths: { mcpConfig } as ClaudePaths,
      store: {
        getAllIntegrationLinks: () => {
          throw new Error('состояние недоступно');
        },
      } as unknown as AppStore,
    };
    expect(
      activateAtlassianMcp(broken, broken.store, join(dir, 'repo'), (error) => errors.push(error)),
    ).toBe(false);
    expect(errors).toHaveLength(1);
  });
});
