import { afterEach, describe, expect, it } from 'vitest';
import {
  startStubTracker,
  type StubTracker,
  type StubTrackerOptions,
} from '../../stub-tracker/src/index.mjs';
import { TrackerError, type TrackerResponse } from './index.ts';
import { ensureOk, parseJson, sendOver, trimUrl } from './client.ts';
import type { TrackerCredentials, TrackerSite, TransportRequest } from './client.types.ts';
import { fromAdf } from './adf.ts';
import {
  accountOf,
  applyTransition,
  commentIssue,
  createIssue,
  issueOf,
  jqlOf,
  linksOf,
  listProjects,
  listTransitions,
  myself,
  readIssue,
  readIssueRaw,
  searchIssues,
} from './jira.ts';

/**
 * Клиент Jira против заглушки трекера по настоящему HTTP: заглушка — внешняя граница (сеть
 * трекера), клиент и порт отправки — настоящие. Заглушка отказывает на перепутанном диалекте
 * авторизации и пишет в след JQL, как его раскодировала, — поэтому ошибка в заголовке или в
 * кодировании JQL здесь краснеет, а не проходит подменой.
 */

const running: StubTracker[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()));
});

/** Транспорт теста — голый fetch (у панели это `sendRequest`, у ядра своя сеть). */
const transported: TransportRequest[] = [];
async function fetchTransport(request: TransportRequest): Promise<TrackerResponse> {
  transported.push(request);
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
}

interface Site {
  stub: StubTracker;
  site: TrackerSite;
  send: ReturnType<typeof sendOver>;
}

async function siteOf(options: StubTrackerOptions = {}): Promise<Site> {
  const stub = await startStubTracker(options);
  running.push(stub);
  const deployment = stub.deployment;
  const agent = stub.users[0]!;
  const credentials: TrackerCredentials = {
    deployment,
    email: deployment === 'cloud' ? agent.email : '',
    token: stub.tokens[agent.name]!,
  };
  return {
    stub,
    site: { baseUrl: stub.url, deployment },
    send: sendOver(fetchTransport, credentials),
  };
}

describe('trackers/client: порт отправки', () => {
  it('облако — Basic почта:токен, своя установка — Bearer: заглушка пускает только свой диалект', async () => {
    for (const deployment of ['cloud', 'server'] as const) {
      const { stub, site, send } = await siteOf({ deployment });
      const response = await myself(site, send);
      expect(response.status).toBe(200);
      expect(stub.requests.at(-1)).toMatchObject({
        auth: deployment === 'cloud' ? 'basic' : 'bearer',
        tokenId: 'agent',
      });
    }
  });

  it('токен уходит только заголовком: ни в адресе, ни в теле запроса его нет', async () => {
    const { stub, site, send } = await siteOf({ deployment: 'server' });
    transported.length = 0;
    await commentIssue(site, send, 'PROJ-2', 'checked');
    const token = stub.tokens.agent!;
    const [request] = transported;
    expect(request!.headers.Authorization).toBe(`Bearer ${token}`);
    expect(request!.headers['Content-Type']).toBe('application/json');
    expect(request!.url).not.toContain(token);
    expect(request!.body).not.toContain(token);
  });

  it('чужой токен — `unauthorized` с кодом ответа, текста ответа в отказе нет', async () => {
    const { site } = await siteOf({ deployment: 'server' });
    const send = sendOver(fetchTransport, { deployment: 'server', email: '', token: 'nope' });
    await expect(listProjects(site, send)).rejects.toMatchObject({
      code: 'unauthorized',
      system: 'Jira',
      status: 401,
      message: 'Jira: unauthorized (401)',
    });
  });

  it('не дошли вовсе — исключение транспорта уходит наверх как есть', async () => {
    const site: TrackerSite = { baseUrl: 'http://127.0.0.1:1', deployment: 'server' };
    const boom = new Error('refused');
    const send = sendOver(() => Promise.reject(boom), {
      deployment: 'server',
      email: '',
      token: 't',
    });
    await expect(readIssue(site, send, 'PROJ-1')).rejects.toBe(boom);
  });

  it('разбор ответа: пусто — null, не JSON при 200 — `bad-response` с этим кодом', () => {
    expect(parseJson('Jira', { status: 204, ok: true, text: '  ' })).toBeNull();
    expect(() => parseJson('Jira', { status: 200, ok: true, text: '<html>' })).toThrow(
      expect.objectContaining({ code: 'bad-response', status: 200 }),
    );
    expect(ensureOk('Jira', { status: 201, ok: true, text: '' }).status).toBe(201);
    expect(() => ensureOk('Jira', { status: 429, ok: false, text: '' })).toThrow(
      expect.objectContaining({ code: 'rate-limited' }),
    );
    expect(trimUrl(' https://tracker.example.com// ')).toBe('https://tracker.example.com');
  });
});

describe('trackers/jira: поиск', () => {
  it('JQL с &, = и кавычками доходит до трекера тем же текстом (закодирован в адресе)', async () => {
    const { stub, site, send } = await siteOf();
    stub.upsertIssue({ key: 'PROJ-7', summary: 'a&b=c "quoted"', labels: ['r&d'] });
    const jql = 'labels = "r&d" AND summary ~ "a&b=c \\"quoted\\""';
    const issues = await searchIssues(site, send, { jql });
    expect(stub.requests.at(-1)?.jql).toBe(jql);
    expect(issues.map((i) => i.key)).toEqual(['PROJ-7']);
  });

  it('свободный текст → `text ~ "…"` с экранированием; готовый JQL сильнее текста', () => {
    expect(jqlOf({ q: ' кнопка "войти" \\ ' })).toBe('text ~ "кнопка \\"войти\\" \\\\"');
    expect(jqlOf({ q: 'x', jql: ' project = PROJ ' })).toBe('project = PROJ');
    expect(jqlOf({ q: '  ' })).toBe('');
  });

  it('`related` читает метки, приоритет, родителя и связи; карточка без них', async () => {
    const { site, send } = await siteOf();
    const jql = 'labels = agentdeck AND assignee = currentUser()';
    const [related] = await searchIssues(site, send, { jql, related: true });
    expect(related).toMatchObject({
      key: 'PROJ-2',
      labels: ['agentdeck'],
      priority: 'High',
      parent: { key: 'PROJ-1', summary: 'Login epic' },
      links: [{ key: 'PROJ-3', relation: 'blocks', direction: 'outward' }],
      description: 'Steps:\nopen the login page\npress the button',
      url: `${site.baseUrl}/browse/PROJ-2`,
      statusCategory: 'new',
    });
    const [card] = await searchIssues(site, send, { jql, limit: 500 });
    expect(card).not.toHaveProperty('labels');
    expect(card).not.toHaveProperty('links');
  });

  it('облако: новый путь поиска ответил 410 — повтор на классическом', async () => {
    const { stub, site, send } = await siteOf();
    stub.fault({ kind: 'status', status: 410, path: '/search/jql$', times: 1 });
    const issues = await searchIssues(site, send, { jql: 'project = PROJ', limit: 0 });
    expect(issues.length).toBe(1);
    const paths = stub.requests.slice(-2).map((r) => r.path.split('?')[0]);
    expect(paths).toEqual(['/rest/api/3/search/jql', '/rest/api/3/search']);
  });

  it('отказ по существу (кривой JQL — 400, 401) не повторяется на соседней ручке', async () => {
    const { stub, site, send } = await siteOf();
    await expect(searchIssues(site, send, { jql: 'sprint = 5' })).rejects.toMatchObject({
      code: 'bad-response',
      status: 400,
    });
    expect(stub.requests).toHaveLength(1);
    await expect(searchIssues(site, send, { jql: '   ' })).rejects.toThrow(RangeError);
  });

  it('своя установка ищет только на классическом /search; оба пути 404 — `not-found`', async () => {
    const { stub, site, send } = await siteOf({ deployment: 'server' });
    const [issue] = await searchIssues(site, send, { jql: 'key = PROJ-2' });
    expect(issue?.description).toContain('press the button');
    expect(stub.requests.at(-1)?.path).toMatch(/^\/rest\/api\/2\/search\?/);

    const cloud = await siteOf();
    cloud.stub.fault({ kind: 'status', status: 404, path: '/search' });
    await expect(
      searchIssues(cloud.site, cloud.send, { jql: 'project = PROJ' }),
    ).rejects.toMatchObject({
      code: 'not-found',
      status: 404,
    });
    expect(cloud.stub.requests).toHaveLength(2);
  });

  it('пустое тело ответа поиска — пустой список, не падение', async () => {
    const site: TrackerSite = { baseUrl: 'https://tracker.example.com', deployment: 'server' };
    const send = () => Promise.resolve({ status: 200, ok: true, text: '' });
    await expect(searchIssues(site, send, { jql: 'project = PROJ' })).resolves.toEqual([]);
    await expect(listProjects(site, send)).resolves.toEqual([]);
    await expect(listProjects({ ...site, deployment: 'cloud' }, send)).resolves.toEqual([]);
    await expect(listTransitions(site, send, 'PROJ-1')).resolves.toEqual([]);
    await expect(readIssue(site, send, 'PROJ-1')).rejects.toBeInstanceOf(TrackerError);
  });
});

describe('trackers/jira: задача, записи, проекты', () => {
  it('задача облака: ADF описания развёрнут в текст; сырой ответ с именами полей', async () => {
    const { site, send } = await siteOf();
    const issue = await readIssue(site, send, 'PROJ-2', { related: true });
    expect(issue.description).toBe('Steps:\nopen the login page\npress the button');
    const raw = (await readIssueRaw(site, send, 'PROJ-2', 'expand=names')) as {
      names: Record<string, string>;
    };
    expect(Object.values(raw.names)).toContain('Acceptance Criteria');
    await expect(readIssue(site, send, 'PROJ-404')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('создание: облаку документ ADF, своей установке текст — заглушка иначе отвечает 400', async () => {
    for (const deployment of ['cloud', 'server'] as const) {
      const { stub, site, send } = await siteOf({ deployment });
      const created = await createIssue(site, send, {
        projectKey: ' PROJ ',
        summary: ' Defect ',
        description: 'line one\nline two',
        labels: ['regress'],
        priority: ' High ',
      });
      expect(created).toMatchObject({ key: 'PROJ-4', summary: 'Defect', type: 'Bug' });
      const stored = stub.state().issues.find((i) => i.key === 'PROJ-4');
      expect(stored).toMatchObject({
        description: 'line one\nline two',
        labels: ['regress'],
        priority: 'High',
      });
    }
    const { site, send } = await siteOf();
    const typed = await createIssue(site, send, {
      projectKey: 'PROJ',
      summary: 'Story',
      description: '',
      issueType: 'Story',
    });
    expect(typed.type).toBe('Story');
  });

  it('комментарий: облаку ADF, своей установке строка; оба приняты заглушкой', async () => {
    for (const deployment of ['cloud', 'server'] as const) {
      const { stub, site, send } = await siteOf({ deployment });
      await commentIssue(site, send, 'PROJ-2', 'MR: https://forge.example.com/mr/1');
      const comments = stub.state().issues.find((i) => i.key === 'PROJ-2')!.comments;
      expect(comments.map((c) => c.text)).toEqual(['MR: https://forge.example.com/mr/1']);
      expect(typeof comments[0]!.body).toBe(deployment === 'cloud' ? 'object' : 'string');
    }
  });

  it('переходы: список с целевым статусом, применение меняет статус задачи', async () => {
    const { stub, site, send } = await siteOf({ deployment: 'server' });
    const transitions = await listTransitions(site, send, 'PROJ-3');
    expect(transitions[2]).toEqual({ id: '31', name: 'Done', to: 'Done' });
    await applyTransition(site, send, 'PROJ-3', ' 31 ');
    expect(stub.state().issues.find((i) => i.key === 'PROJ-3')?.statusCategory).toBe('done');
    const bare = () =>
      Promise.resolve({ status: 200, ok: true, text: '{"transitions":[{"id":5,"name":"Go"}]}' });
    await expect(listTransitions(site, bare, 'PROJ-3')).resolves.toEqual([{ id: '5', name: 'Go' }]);
  });

  it('проекты: облако постранично, своя установка массивом', async () => {
    for (const deployment of ['cloud', 'server'] as const) {
      const { site, send } = await siteOf({ deployment });
      await expect(listProjects(site, send)).resolves.toEqual([
        { id: '10000', key: 'PROJ', name: 'Stub project' },
      ]);
    }
  });

  it('имя учётки: displayName, затем name, затем почта; ничего — нет имени', () => {
    expect(accountOf({ displayName: ' Olga ', name: 'o' })).toBe('Olga');
    expect(accountOf({ name: 'o' })).toBe('o');
    expect(accountOf({ emailAddress: 'o@tracker.example.com' })).toBe('o@tracker.example.com');
    expect(accountOf(null)).toBeUndefined();
  });

  it('связи и поля без значений: сосед без ключа выброшен, связь без имени — без relation', () => {
    expect(
      linksOf([
        { type: { name: 'X' }, inwardIssue: { key: 'PROJ-9' } },
        { type: { outward: 'blocks' }, outwardIssue: {} },
      ]),
    ).toEqual([{ key: 'PROJ-9', direction: 'inward' }]);
    expect(linksOf('nope')).toEqual([]);
    const site: TrackerSite = { baseUrl: 'https://tracker.example.com', deployment: 'server' };
    expect(issueOf(site, { key: 'PROJ-1' }, true)).toEqual({
      key: 'PROJ-1',
      summary: '',
      status: '',
      statusCategory: undefined,
      type: '',
      assignee: undefined,
      updatedAt: undefined,
      url: 'https://tracker.example.com/browse/PROJ-1',
      description: undefined,
      labels: [],
      links: [],
    });
    expect(
      issueOf(site, { key: 'PROJ-2', fields: { labels: 'x', parent: { key: 'PROJ-1' } } }, true),
    ).toMatchObject({ labels: [], parent: { key: 'PROJ-1' } });
    expect(fromAdf(42)).toBe('42');
  });
});
