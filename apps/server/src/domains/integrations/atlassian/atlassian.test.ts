import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AtlassianSettings } from '@agentdeck/contracts';
import { authHeaders, confluenceRoot, detectDeployment, jiraApi, toAccess } from './client.ts';
import { fromAdf, toAdf } from './adf.ts';
import {
  applyTransition,
  commentIssue,
  createIssue,
  listProjects,
  listTransitions,
  readIssue,
  searchIssues,
} from './jira.ts';
import {
  createPage,
  listSpaces,
  readPage,
  searchPages,
  storageToText,
  textToStorage,
  updatePage,
} from './confluence.ts';

/**
 * Клиент Atlassian на два диалекта. Проверяем ровно то, из-за чего диалекты
 * вообще заведены: разные пути, разная авторизация и разные тела ответов при
 * одном и том же смысле. Плюс отказы: 401 обязан читаться как «токен отклонён»,
 * а пустой адрес — как незаполненное поле, а не как сетевая ошибка.
 *
 * Сеть подменена: ни один тест здесь никуда не ходит.
 */

interface Reply {
  status?: number;
  body?: unknown;
}

/** Подмена `fetch` картой «кусок адреса → ответ». Порядок обращений записывается. */
function stubApi(routes: [RegExp, Reply][]): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const found = routes.find(([pattern]) => pattern.test(String(url)));
    const reply = found?.[1] ?? { status: 404, body: { message: 'нет такой ручки' } };
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
      }),
    );
  });
  return { calls };
}

const CLOUD = {
  baseUrl: 'https://acme.atlassian.net',
  email: 'qa@acme.io',
  token: 'CLOUD-SECRET',
  deployment: 'cloud' as const,
  confluenceUrl: '',
};

const SERVER = {
  baseUrl: 'https://jira.acme.local',
  email: '',
  token: 'PAT-SECRET',
  deployment: 'server' as const,
  confluenceUrl: 'https://wiki.acme.local',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('atlassian/client: два диалекта', () => {
  it('облако ходит Basic на v3, своя установка — Bearer на v2', () => {
    expect(authHeaders(CLOUD).Authorization).toBe(
      `Basic ${Buffer.from('qa@acme.io:CLOUD-SECRET').toString('base64')}`,
    );
    expect(authHeaders(SERVER).Authorization).toBe('Bearer PAT-SECRET');
    expect(jiraApi(CLOUD)).toBe('https://acme.atlassian.net/rest/api/3');
    expect(jiraApi(SERVER)).toBe('https://jira.acme.local/rest/api/2');
  });

  it('Confluence облака живёт под /wiki, своя установка — в корне своего адреса', () => {
    expect(confluenceRoot(CLOUD)).toBe('https://acme.atlassian.net/wiki');
    expect(confluenceRoot(SERVER)).toBe('https://wiki.acme.local');
    // Задан отдельный адрес — /wiki не приписывается: это уже чужой хост.
    expect(confluenceRoot({ ...CLOUD, confluenceUrl: 'https://wiki.acme.io/' })).toBe(
      'https://wiki.acme.io',
    );
  });

  it('пустой адрес — это незаполненное поле (400), а не сетевая ошибка', () => {
    const settings: AtlassianSettings = {
      enabled: true,
      baseUrl: '  ',
      email: '',
      deployment: '',
      confluenceUrl: '',
    };
    expect(() => toAccess(settings, 'token')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'invalid_body' }),
    );
  });

  it('вид установки не записан — почта решает, куда метил человек', () => {
    const base: AtlassianSettings = {
      enabled: true,
      baseUrl: 'https://acme.atlassian.net/',
      email: 'qa@acme.io',
      deployment: '',
      confluenceUrl: '',
    };
    expect(toAccess(base, 't').deployment).toBe('cloud');
    expect(toAccess({ ...base, email: '' }, 't').deployment).toBe('server');
    // Хвостовой слэш срезается: иначе пути склеиваются с двойным.
    expect(toAccess(base, 't').baseUrl).toBe('https://acme.atlassian.net');
  });

  it('определение диалекта: облако отвечает на v3 — на v2 уже не ходим', async () => {
    const { calls } = stubApi([[/rest\/api\/3\/myself/, { body: { displayName: 'Ольга' } }]]);
    await expect(
      detectDeployment({
        baseUrl: 'https://acme.atlassian.net',
        email: 'qa@acme.io',
        token: 't',
        confluenceUrl: '',
      }),
    ).resolves.toEqual({ deployment: 'cloud', account: 'Ольга' });
    expect(calls).toHaveLength(1);
  });

  it('облако не ответило — пробуем свою установку и запоминаем её', async () => {
    stubApi([
      [/rest\/api\/3\/myself/, { status: 404 }],
      [/rest\/api\/2\/myself/, { body: { name: 'qa' } }],
    ]);
    await expect(
      detectDeployment({
        baseUrl: 'https://jira.acme.local',
        email: 'qa@acme.io',
        token: 't',
        confluenceUrl: '',
      }),
    ).resolves.toEqual({ deployment: 'server', account: 'qa' });
  });

  it('без почты облачный диалект не пробуется вовсе', async () => {
    const { calls } = stubApi([[/rest\/api\/2\/myself/, { body: { displayName: 'PAT' } }]]);
    await detectDeployment({
      baseUrl: 'https://jira.acme.local',
      email: '',
      token: 't',
      confluenceUrl: '',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/rest/api/2/myself');
  });

  it('401 у обоих — «токен отклонён», и показывается отказ ОБЛАКА', async () => {
    stubApi([
      [/rest\/api\/3\/myself/, { status: 401, body: { message: 'unauthorized' } }],
      [/rest\/api\/2\/myself/, { status: 500 }],
    ]);
    await expect(
      detectDeployment({
        baseUrl: 'https://acme.atlassian.net',
        email: 'qa@acme.io',
        token: 'bad',
        confluenceUrl: '',
      }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('токен отклонён'),
    });
  });

  it('нет адреса или нет токена — 400 с именем поля, без единого запроса', async () => {
    const { calls } = stubApi([]);
    await expect(
      detectDeployment({ baseUrl: '', email: '', token: 't', confluenceUrl: '' }),
    ).rejects.toMatchObject({ detail: 'baseUrl' });
    await expect(
      detectDeployment({ baseUrl: 'https://x', email: '', token: '', confluenceUrl: '' }),
    ).rejects.toMatchObject({ detail: 'token' });
    expect(calls).toHaveLength(0);
  });
});

describe('atlassian/adf: документ облака и текст своей установки', () => {
  it('текст разворачивается в документ и сворачивается обратно', () => {
    const doc = toAdf('первая\n\nвторая');
    expect(doc.type).toBe('doc');
    expect(fromAdf(doc)).toBe('первая\n\nвторая');
  });

  it('текст своей установки остаётся текстом', () => {
    expect(fromAdf('обычная строка')).toBe('обычная строка');
    expect(fromAdf(undefined)).toBeUndefined();
  });
});

describe('atlassian/jira', () => {
  it('проекты: у облака страница, у своей установки массив', async () => {
    stubApi([[/project\/search/, { body: { values: [{ id: 1, key: 'CMP', name: 'Компания' }] } }]]);
    await expect(listProjects(CLOUD)).resolves.toEqual([{ id: '1', key: 'CMP', name: 'Компания' }]);

    stubApi([[/rest\/api\/2\/project$/, { body: [{ id: 2, key: 'QA', name: 'Тесты' }] }]]);
    await expect(listProjects(SERVER)).resolves.toEqual([{ id: '2', key: 'QA', name: 'Тесты' }]);
  });

  it('свободный текст превращается в JQL и экранируется', async () => {
    const { calls } = stubApi([[/search\/jql/, { body: { issues: [] } }]]);
    await searchIssues(CLOUD, { q: 'кнопка "войти"' });
    expect(decodeURIComponent(calls[0]!.url)).toContain('text ~ "кнопка \\"войти\\""');
  });

  it('облако: новый путь поиска отвалился 410 — честно повторяем на старом', async () => {
    const { calls } = stubApi([
      [/search\/jql/, { status: 410 }],
      [/\/search\?/, { body: { issues: [{ key: 'PRJ-1', fields: { summary: 'Падает' } }] } }],
    ]);
    const issues = await searchIssues(CLOUD, { jql: 'project = PRJ' });
    expect(issues[0]).toMatchObject({ key: 'PRJ-1', summary: 'Падает' });
    expect(issues[0]?.url).toBe('https://acme.atlassian.net/browse/PRJ-1');
    expect(calls).toHaveLength(2);
  });

  it('отказ по существу (401) НЕ повторяется на соседней ручке', async () => {
    const { calls } = stubApi([[/search/, { status: 401 }]]);
    await expect(searchIssues(CLOUD, { jql: 'project = PRJ' })).rejects.toMatchObject({
      message: expect.stringContaining('токен отклонён'),
    });
    expect(calls).toHaveLength(1);
  });

  it('пустой запрос — 400 с именем поля, без обращения наружу', async () => {
    const { calls } = stubApi([]);
    await expect(searchIssues(CLOUD, {})).rejects.toMatchObject({ detail: 'q' });
    expect(calls).toHaveLength(0);
  });

  it('задача читается с описанием: у облака ADF разворачивается в текст', async () => {
    stubApi([
      [
        /issue\/PRJ-7/,
        {
          body: {
            key: 'PRJ-7',
            fields: {
              summary: 'Не грузится',
              status: { name: 'Открыт' },
              issuetype: { name: 'Bug' },
              assignee: { displayName: 'Ольга' },
              description: toAdf('шаги внутри'),
            },
          },
        },
      ],
    ]);
    await expect(readIssue(CLOUD, 'PRJ-7')).resolves.toMatchObject({
      key: 'PRJ-7',
      status: 'Открыт',
      assignee: 'Ольга',
      description: 'шаги внутри',
    });
  });

  it('создание: облаку уходит документ, своей установке — текст; тип по умолчанию Bug', async () => {
    const cloud = stubApi([
      [/rest\/api\/3\/issue$/, { body: { key: 'PRJ-9' } }],
      [/issue\/PRJ-9/, { body: { key: 'PRJ-9', fields: { summary: 'Дефект' } } }],
    ]);
    await createIssue(CLOUD, { projectKey: 'PRJ', summary: 'Дефект', description: 'тело' });
    const cloudBody = JSON.parse(String(cloud.calls[0]!.init.body)) as {
      fields: { description: unknown; issuetype: { name: string } };
    };
    expect(cloudBody.fields.issuetype.name).toBe('Bug');
    expect(cloudBody.fields.description).toMatchObject({ type: 'doc' });

    const server = stubApi([
      [/rest\/api\/2\/issue$/, { body: { key: 'QA-1' } }],
      [/issue\/QA-1/, { body: { key: 'QA-1', fields: {} } }],
    ]);
    await createIssue(SERVER, {
      projectKey: 'QA',
      summary: 'Дефект',
      description: 'тело',
      labels: ['regress'],
    });
    const serverBody = JSON.parse(String(server.calls[0]!.init.body)) as {
      fields: { description: unknown; labels: string[] };
    };
    expect(serverBody.fields.description).toBe('тело');
    expect(serverBody.fields.labels).toEqual(['regress']);
  });

  it('пустые обязательные поля задачи — 400 с именем поля', async () => {
    stubApi([]);
    await expect(
      createIssue(CLOUD, { projectKey: ' ', summary: 'x', description: '' }),
    ).rejects.toMatchObject({ detail: 'projectKey' });
    await expect(
      createIssue(CLOUD, { projectKey: 'PRJ', summary: ' ', description: '' }),
    ).rejects.toMatchObject({ detail: 'summary' });
  });

  it('комментарий и переход статуса уходят в свои ручки', async () => {
    const { calls } = stubApi([
      [/comment/, { body: {} }],
      [/transitions/, { body: { transitions: [{ id: 31, name: 'Готово' }] } }],
    ]);
    await commentIssue(SERVER, 'QA-1', 'проверено');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ body: 'проверено' });

    await expect(listTransitions(SERVER, 'QA-1')).resolves.toEqual([{ id: '31', name: 'Готово' }]);
    await applyTransition(SERVER, 'QA-1', '31');
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ transition: { id: '31' } });
  });

  it('пустой комментарий и пустой переход не уходят наружу', async () => {
    const { calls } = stubApi([]);
    await expect(commentIssue(CLOUD, 'PRJ-1', '  ')).rejects.toMatchObject({ detail: 'body' });
    await expect(applyTransition(CLOUD, 'PRJ-1', ' ')).rejects.toMatchObject({ detail: 'id' });
    expect(calls).toHaveLength(0);
  });
});

describe('atlassian/confluence', () => {
  it('пространства читаются из своего API у каждого диалекта', async () => {
    stubApi([[/api\/v2\/spaces/, { body: { results: [{ id: 5, key: 'QA', name: 'Тесты' }] } }]]);
    await expect(listSpaces(CLOUD)).resolves.toEqual([{ id: '5', key: 'QA', name: 'Тесты' }]);

    stubApi([[/rest\/api\/space/, { body: { results: [{ id: 7, key: 'DOC', name: 'Доки' }] } }]]);
    await expect(listSpaces(SERVER)).resolves.toEqual([{ id: '7', key: 'DOC', name: 'Доки' }]);
  });

  it('поиск идёт по CQL старого content-API у ОБОИХ — у облака под /wiki', async () => {
    const { calls } = stubApi([
      [/content\/search/, { body: { results: [{ id: 12, title: 'Требования' }] } }],
    ]);
    await searchPages(CLOUD, 'требования');
    expect(calls[0]!.url).toContain('/wiki/rest/api/content/search');

    const server = stubApi([[/content\/search/, { body: { results: [] } }]]);
    await searchPages(SERVER, 'требования');
    expect(server.calls[0]!.url).toContain('https://wiki.acme.local/rest/api/content/search');
  });

  it('пустой запрос поиска — 400, наружу не ходим', async () => {
    const { calls } = stubApi([]);
    await expect(searchPages(CLOUD, '   ')).rejects.toMatchObject({ detail: 'q' });
    expect(calls).toHaveLength(0);
  });

  it('страница облака: тело приходит текстом, пространство — по spaceId', async () => {
    stubApi([
      [
        /api\/v2\/pages\/12/,
        {
          body: {
            id: 12,
            title: 'Требования',
            spaceId: '5',
            version: { number: 3 },
            body: { storage: { value: '<p>Первый</p><p>Второй</p>' } },
            _links: { webui: '/spaces/QA/pages/12' },
          },
        },
      ],
      [/api\/v2\/spaces\/5/, { body: { key: 'QA' } }],
    ]);
    await expect(readPage(CLOUD, '12')).resolves.toEqual({
      id: '12',
      title: 'Требования',
      spaceKey: 'QA',
      url: 'https://acme.atlassian.net/wiki/spaces/QA/pages/12',
      version: 3,
      body: 'Первый\nВторой',
    });
  });

  it('нет прав на пространство — страница всё равно показывается', async () => {
    stubApi([
      [/api\/v2\/pages\/12/, { body: { id: 12, title: 'Т', spaceId: '5' } }],
      [/api\/v2\/spaces\/5/, { status: 403 }],
    ]);
    await expect(readPage(CLOUD, '12')).resolves.toMatchObject({ spaceKey: '', title: 'Т' });
  });

  it('создание страницы: облаку нужен числовой spaceId, своей установке — ключ', async () => {
    const cloud = stubApi([
      [/api\/v2\/spaces\?keys=QA/, { body: { results: [{ id: '5', key: 'QA' }] } }],
      [/api\/v2\/pages$/, { body: { id: 99, title: 'Отчёт', version: { number: 1 } } }],
    ]);
    await createPage(CLOUD, { spaceKey: 'QA', title: 'Отчёт', body: '<p>x</p>', parentId: '12' });
    const cloudBody = JSON.parse(String(cloud.calls[1]!.init.body)) as {
      spaceId: string;
      parentId: string;
    };
    expect(cloudBody).toMatchObject({ spaceId: '5', parentId: '12' });

    const server = stubApi([[/rest\/api\/content$/, { body: { id: 77, title: 'Отчёт' } }]]);
    await createPage(SERVER, { spaceKey: 'DOC', title: 'Отчёт', body: '<p>x</p>' });
    const serverBody = JSON.parse(String(server.calls[0]!.init.body)) as {
      space: { key: string };
      type: string;
    };
    expect(serverBody).toMatchObject({ type: 'page', space: { key: 'DOC' } });
  });

  it('несуществующее пространство названо словами, а не 404 от чужого API', async () => {
    stubApi([[/api\/v2\/spaces\?keys=NOPE/, { body: { results: [] } }]]);
    await expect(
      createPage(CLOUD, { spaceKey: 'NOPE', title: 'x', body: '' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('пространства «NOPE»') });
  });

  it('обновление читает текущую версию само и ставит следующую', async () => {
    const { calls } = stubApi([
      [
        /api\/v2\/pages\/12\?/,
        { body: { id: 12, title: 'Требования', spaceId: '5', version: { number: 4 } } },
      ],
      [/api\/v2\/spaces\/5/, { body: { key: 'QA' } }],
      [/api\/v2\/pages\/12$/, { body: { id: 12, title: 'Требования', version: { number: 5 } } }],
    ]);
    await updatePage(CLOUD, '12', { body: '<p>новое</p>' });
    const body = JSON.parse(String(calls.at(-1)!.init.body)) as { version: { number: number } };
    expect(body.version.number).toBe(5);
  });

  it('текст ↔ storage: разметка уходит, сущности возвращаются', () => {
    expect(storageToText('<h1>Заголовок</h1><p>Абзац &amp; хвост</p><br/>')).toBe(
      'Заголовок\nАбзац & хвост',
    );
    expect(textToStorage('a < b\n\nc')).toBe('<p>a &lt; b</p><p>&nbsp;</p><p>c</p>');
  });
});
