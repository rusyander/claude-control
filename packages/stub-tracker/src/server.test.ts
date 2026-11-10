import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCEPTANCE_FIELD_ID,
  DEFAULT_USERS,
  parseJql,
  startStubTracker,
  type StubTracker,
  type StubTrackerOptions,
} from './index.mjs';

/**
 * Заглушка трекера — граница тестов клиента и входящих ядра, поэтому её собственные обещания
 * проверены здесь по настоящему HTTP: диалект авторизации, JQL как его понял сервер, формы ответа
 * облака и своей установки, след без значения доступа, сбои.
 */

const running: StubTracker[] = [];
const dirs: string[] = [];

async function start(options: StubTrackerOptions = {}): Promise<StubTracker> {
  const stub = await startStubTracker(options);
  running.push(stub);
  return stub;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const agent = DEFAULT_USERS[0]!;
const basic = (email: string, token: string) =>
  `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

/** Поля ответов Jira, которые читают эти тесты; значение каждого проверяет сам тест. */
interface Reply {
  issues: { key: string }[];
  isLast: boolean;
  errorMessages: string[];
  fields: Record<string, unknown>;
  names: Record<string, string>;
  transitions: { id: string }[];
}

async function get(stub: StubTracker, path: string, authorization?: string) {
  const response = await fetch(`${stub.url}${path}`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Reply) : null };
}

async function post(stub: StubTracker, path: string, body: unknown, authorization: string) {
  const response = await fetch(`${stub.url}${path}`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Reply) : null };
}

describe('stub-tracker: порт и параметры', () => {
  it('порты панели 5170–5180 и незнакомые параметры отклоняются до запуска', async () => {
    await expect(startStubTracker({ port: 5178 })).rejects.toThrow(/reserved/);
    await expect(startStubTracker({ port: -1 })).rejects.toThrow(/not a TCP port/);
    await expect(startStubTracker({ bogus: 1 } as never)).rejects.toThrow(/unknown option/);
    await expect(startStubTracker({ deployment: 'dc' as never })).rejects.toThrow(/deployment/);
  });

  it('слушает только loopback', async () => {
    const stub = await start();
    expect(stub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('stub-tracker: диалект авторизации', () => {
  it('облако: Basic почта:токен проходит на v3 и v2, Bearer того же токена — 401', async () => {
    const stub = await start({ deployment: 'cloud' });
    const auth = basic(agent.email, agent.token);
    expect((await get(stub, '/rest/api/3/myself', auth)).body).toMatchObject({
      displayName: 'Stub Agent',
      accountId: 'acc-agent',
    });
    expect((await get(stub, '/rest/api/2/myself', auth)).status).toBe(200);
    expect((await get(stub, '/rest/api/3/myself', `Bearer ${agent.token}`)).status).toBe(401);
    expect((await get(stub, '/rest/api/3/myself', basic(agent.email, 'wrong'))).status).toBe(401);
    expect((await get(stub, '/rest/api/3/myself')).status).toBe(401);
  });

  it('своя установка: Bearer на v2, Basic — 401, v3 и /search/jql — 404', async () => {
    const stub = await start({ deployment: 'server' });
    expect((await get(stub, '/rest/api/2/myself', `Bearer ${agent.token}`)).body).toMatchObject({
      name: 'agent',
      key: 'agent',
    });
    expect((await get(stub, '/rest/api/2/myself', basic(agent.email, agent.token))).status).toBe(
      401,
    );
    expect((await get(stub, '/rest/api/3/myself', `Bearer ${agent.token}`)).status).toBe(404);
    expect(
      (await get(stub, '/rest/api/2/search/jql?jql=project%3DPROJ', `Bearer ${agent.token}`))
        .status,
    ).toBe(404);
  });

  it('след называет схему и учётку, но не значение доступа', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stub-tracker-'));
    dirs.push(dir);
    const trace = join(dir, 'trace.jsonl');
    const stub = await start({ deployment: 'server', trace });
    await get(stub, '/rest/api/2/myself', `Bearer ${agent.token}`);
    await get(stub, '/rest/api/2/myself', 'Bearer not-a-token');
    await get(stub, '/rest/api/2/myself');
    const lines = readFileSync(trace, 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toMatchObject([
      { auth: 'bearer', tokenId: 'agent', status: 200 },
      { auth: 'bearer', tokenId: 'unknown', status: 401 },
      { auth: null, tokenId: null, status: 401 },
    ]);
    expect(readFileSync(trace, 'utf8')).not.toContain(agent.token);
  });
});

describe('stub-tracker: поиск по JQL', () => {
  it('метки + исполнитель-я: JQL раскодирован в следе, найдено ровно своё', async () => {
    const stub = await start();
    const auth = basic(agent.email, agent.token);
    const jql = 'labels in ("agentdeck") AND assignee = currentUser() ORDER BY key DESC';
    const reply = await get(stub, `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}`, auth);
    expect(reply.status).toBe(200);
    expect(reply.body!.issues.map((i: { key: string }) => i.key)).toEqual(['PROJ-2']);
    expect(reply.body!.isLast).toBe(true);
    expect(stub.requests.at(-1)?.jql).toBe(jql);
  });

  it('классический /search — страница с total; text ~ ищет и в комментариях', async () => {
    const stub = await start({ deployment: 'server' });
    const auth = `Bearer ${agent.token}`;
    await post(stub, '/rest/api/2/issue/PROJ-3/comment', { body: 'needle inside' }, auth);
    const jql = 'text ~ "needle"';
    const reply = await get(stub, `/rest/api/2/search?jql=${encodeURIComponent(jql)}`, auth);
    expect(reply.body).toMatchObject({ startAt: 0, total: 1 });
    expect(reply.body!.issues[0]?.key).toBe('PROJ-3');
  });

  it('незнакомое условие — 400 с errorMessages, а не «нашлось всё»', async () => {
    const stub = await start();
    const auth = basic(agent.email, agent.token);
    const reply = await get(
      stub,
      `/rest/api/3/search?jql=${encodeURIComponent('sprint = 5')}`,
      auth,
    );
    expect(reply.status).toBe(400);
    expect(reply.body!.errorMessages[0]).toMatch(/JQL/);
  });

  it('разбор JQL: not in, is EMPTY, !=, кавычки с экранированием', () => {
    expect(
      parseJql('key not in (PROJ-1, "PROJ-2") AND parent is EMPTY AND status != Done'),
    ).toEqual({
      clauses: [
        { field: 'key', op: 'not-in', values: ['PROJ-1', 'PROJ-2'] },
        { field: 'parent', op: 'empty' },
        { field: 'status', op: '!=', values: ['Done'] },
      ],
      order: [],
    });
    expect(parseJql('summary ~ "say \\"hi\\""').clauses[0]).toEqual({
      field: 'summary',
      op: '~',
      values: ['say "hi"'],
    });
    expect(() => parseJql('summary = x')).toThrow(/only ~/);
    expect(() => parseJql('labels ~ x')).toThrow(/not supported/);
    expect(() => parseJql('labels = "open')).toThrow(/unterminated/);
  });
});

describe('stub-tracker: задача', () => {
  it('облако: описание и критерии — документы ADF, родитель и связи с направлением, имена полей', async () => {
    const stub = await start();
    const auth = basic(agent.email, agent.token);
    const reply = await get(stub, '/rest/api/3/issue/PROJ-2?expand=names', auth);
    const fields = reply.body!.fields;
    expect(fields.description).toMatchObject({ type: 'doc', version: 1 });
    expect(fields.parent).toEqual({ key: 'PROJ-1', fields: { summary: 'Login epic' } });
    expect(fields.issuelinks).toEqual([
      {
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        outwardIssue: { key: 'PROJ-3', fields: { summary: 'Session storage' } },
      },
    ]);
    expect(fields[ACCEPTANCE_FIELD_ID]).toMatchObject({ type: 'doc' });
    expect(reply.body!.names[ACCEPTANCE_FIELD_ID]).toBe('Acceptance Criteria');
  });

  it('своя установка: описание строкой; fields= отдаёт только названные поля', async () => {
    const stub = await start({ deployment: 'server' });
    const reply = await get(
      stub,
      '/rest/api/2/issue/PROJ-2?fields=summary,description,labels',
      `Bearer ${agent.token}`,
    );
    expect(Object.keys(reply.body!.fields).sort()).toEqual(['description', 'labels', 'summary']);
    expect(reply.body!.fields.description).toContain('press the button');
    expect((await get(stub, '/rest/api/2/issue/PROJ-99', `Bearer ${agent.token}`)).status).toBe(
      404,
    );
  });

  it('создание и комментарий: облаку нужен ADF, своей установке — строка', async () => {
    const cloud = await start();
    const auth = basic(agent.email, agent.token);
    const asText = await post(cloud, '/rest/api/3/issue/PROJ-2/comment', { body: 'plain' }, auth);
    expect(asText.status).toBe(400);
    const doc = { type: 'doc', version: 1, content: [] };
    const created = await post(
      cloud,
      '/rest/api/3/issue',
      {
        fields: {
          project: { key: 'PROJ' },
          summary: 'New',
          issuetype: { name: 'Bug' },
          description: doc,
        },
      },
      auth,
    );
    expect(created).toMatchObject({ status: 201, body: { key: 'PROJ-4' } });
    const missing = await post(
      cloud,
      '/rest/api/3/issue',
      { fields: { project: { key: 'NOPE' } } },
      auth,
    );
    expect(missing.status).toBe(400);

    const server = await start({ deployment: 'server' });
    const bearer = `Bearer ${agent.token}`;
    const asDoc = await post(server, '/rest/api/2/issue/PROJ-2/comment', { body: doc }, bearer);
    expect(asDoc.status).toBe(400);
    const ok = await post(server, '/rest/api/2/issue/PROJ-2/comment', { body: 'done' }, bearer);
    expect(ok).toMatchObject({ status: 201, body: { body: 'done', author: { name: 'agent' } } });
    expect(server.state().issues.find((i) => i.key === 'PROJ-2')?.comments).toHaveLength(1);
  });

  it('переход меняет статус и категорию; неизвестный переход — 400', async () => {
    const stub = await start({ deployment: 'server' });
    const bearer = `Bearer ${agent.token}`;
    const list = await get(stub, '/rest/api/2/issue/PROJ-3/transitions', bearer);
    expect(list.body!.transitions.map((t: { id: string }) => t.id)).toEqual(['11', '21', '31']);
    const moved = await fetch(`${stub.url}/rest/api/2/issue/PROJ-3/transitions`, {
      method: 'POST',
      headers: { Authorization: bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: '31' } }),
    });
    expect(moved.status).toBe(204);
    expect(stub.state().issues.find((i) => i.key === 'PROJ-3')).toMatchObject({
      status: 'Done',
      statusCategory: 'done',
    });
    expect(
      (
        await post(
          stub,
          '/rest/api/2/issue/PROJ-3/transitions',
          { transition: { id: '9' } },
          bearer,
        )
      ).status,
    ).toBe(400);
  });

  it('проекты: у облака страница /project/search, у своей установки массив /project', async () => {
    const cloud = await start();
    expect(
      (await get(cloud, '/rest/api/3/project/search', basic(agent.email, agent.token))).body,
    ).toMatchObject({
      values: [{ key: 'PROJ' }],
    });
    const server = await start({ deployment: 'server' });
    expect((await get(server, '/rest/api/2/project', `Bearer ${agent.token}`)).body).toEqual([
      { id: '10000', key: 'PROJ', name: 'Stub project' },
    ]);
  });
});

describe('stub-tracker: управление и сбои', () => {
  it('правка «другим человеком» двигает updated; сбой по пути срабатывает заданное число раз', async () => {
    let clock = 1_000;
    const stub = await start({ deployment: 'server', now: () => clock });
    clock = 5_000;
    stub.upsertIssue({ key: 'PROJ-3', summary: 'Session storage v2' });
    expect(stub.state().issues.find((i) => i.key === 'PROJ-3')).toMatchObject({
      summary: 'Session storage v2',
      updated: 5_000,
      created: 1_000,
    });
    stub.fault({ kind: 'status', status: 410, path: '/search', times: 1 });
    const bearer = `Bearer ${agent.token}`;
    expect((await get(stub, '/rest/api/2/search?jql=project%3DPROJ', bearer)).status).toBe(410);
    expect((await get(stub, '/rest/api/2/search?jql=project%3DPROJ', bearer)).status).toBe(200);
    stub.fault({ kind: 'garbage' });
    const garbage = await fetch(`${stub.url}/rest/api/2/myself`);
    expect(await garbage.text()).toContain('<html>');
    stub.clearFaults();
    expect(() => stub.fault({ kind: 'nope' as never })).toThrow(/unknown fault/);
  });

  it('управляющие пути: состояние, засев задачи, сбой', async () => {
    const stub = await start();
    const seeded = await fetch(`${stub.url}/__stub/issue`, {
      method: 'POST',
      body: JSON.stringify({ key: 'PROJ-10', summary: 'Seeded', labels: ['x'] }),
    });
    expect(await seeded.json()).toEqual({ key: 'PROJ-10' });
    const bad = await fetch(`${stub.url}/__stub/issue`, {
      method: 'POST',
      body: '{"key":"lower-1"}',
    });
    expect(bad.status).toBe(400);
    const state = (await (await fetch(`${stub.url}/__stub/state`)).json()) as {
      issues: { key: string }[];
      users: Record<string, unknown>[];
    };
    expect(state.issues.map((i) => i.key)).toContain('PROJ-10');
    expect(JSON.stringify(state.users)).not.toContain(agent.token);
    await fetch(`${stub.url}/__stub/fault`, {
      method: 'POST',
      body: '{"kind":"status","status":503}',
    });
    expect((await fetch(`${stub.url}/rest/api/3/myself`)).status).toBe(503);
    await fetch(`${stub.url}/__stub/fault`, { method: 'DELETE' });
    expect((await fetch(`${stub.url}/__stub/nope`)).status).toBe(404);
  });
});
