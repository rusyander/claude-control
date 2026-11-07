import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { intakeSourceSchema, type IntakeSource } from '@agentdeck/contracts/core/intake';
import type { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { registerCoreProxyRoutes } from '../../routes/core-proxy/core-proxy-routes.ts';
import { TRACKER_SNAPSHOT_ROUTE } from '../../routes/core-proxy/intake-snapshot-route.ts';
import { readIntegrations, writeSettings, writeToken } from '../integrations/store/store.ts';

/**
 * Снимок задачи трекера для экрана запуска (этап 11, P133, W3-16) — настоящая дорога панели:
 * регистрация прокладки ядра с контекстом → маршрут → домен `core-intake` → клиент Atlassian →
 * `fetch`. Подменена только сеть (тот же приём `stubApi`, что у `atlassian.test.ts`): ни один тест
 * здесь в трекер не ходит. Настройки и ключ Jira — настоящий `AppStore` во временной папке.
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
    const reply = found?.[1] ?? { status: 404, body: { errorMessages: ['нет такой задачи'] } };
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
      }),
    );
  });
  return { calls };
}

const SECRET = 'PAT-SECRET';
const BASE = 'https://jira.acme.local';

const ISSUE = {
  key: 'PROJ-12',
  fields: {
    summary: 'Кнопка экспорта в отчёте',
    description: 'Добавить кнопку экспорта CSV.',
    status: { name: 'В работе', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    labels: ['report'],
    updated: '2026-11-05T10:00:00.000+0000',
    customfield_10042: '- Кнопка видна на странице отчёта\n* Файл CSV содержит все строки\n\n',
    customfield_10050: 'не критерий',
    issuelinks: [{ type: { outward: 'blocks' }, outwardIssue: { key: 'PROJ-13' } }],
  },
  names: { customfield_10042: 'Acceptance Criteria', customfield_10050: 'Team' },
};

let dir: string;
let store: AppStore;
let app: FastifyInstance;

function connect(deployment: 'server' | 'cloud', baseUrl = BASE): void {
  writeSettings(store, 'jira', {
    ...readIntegrations(store).jira,
    enabled: true,
    baseUrl,
    email: deployment === 'cloud' ? 'qa@acme.io' : '',
    deployment,
  });
  writeToken(dir, 'jira', SECRET);
}

async function snapshot(key: string) {
  const res = await app.inject({
    method: 'GET',
    url: `${TRACKER_SNAPSHOT_ROUTE}?key=${encodeURIComponent(key)}`,
  });
  return { status: res.statusCode, body: res.json() as IntakeSource & { code?: string } };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tracker-snapshot-'));
  store = new AppStore(dir);
  app = Fastify();
  const context = { store, location: { paths: { appData: dir } } } as unknown as Pick<
    ServerContext,
    'store' | 'location'
  >;
  registerCoreProxyRoutes(app, {}, context);
  await app.ready();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('core-intake tracker snapshot through the panel route (W3-16, P133)', () => {
  it('freezes title, body, fields, structured AC from the AC field, links and a digest', async () => {
    connect('server');
    const api = stubApi([[/\/rest\/api\/2\/issue\/PROJ-12\?expand=names$/, { body: ISSUE }]]);
    const { status, body } = await snapshot('PROJ-12');
    expect(status).toBe(200);
    expect(intakeSourceSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      kind: 'tracker',
      key: 'PROJ-12',
      title: 'Кнопка экспорта в отчёте',
      body: 'Добавить кнопку экспорта CSV.',
      fields: {
        status: 'В работе',
        statusCategory: 'indeterminate',
        type: 'Story',
        priority: 'High',
        labels: ['report'],
      },
      acceptance: ['Кнопка видна на странице отчёта', 'Файл CSV содержит все строки'],
      links: [
        { url: `${BASE}/browse/PROJ-12`, title: 'PROJ-12' },
        { url: `${BASE}/browse/PROJ-13`, title: 'blocks PROJ-13' },
      ],
    });
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    // Одно чтение, только GET, своя установка — Bearer с ключом из хранилища.
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.init.method ?? 'GET').toBe('GET');
    expect((api.calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${SECRET}`,
    );
    // Ключ Jira не уходит в ответ панели.
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('the same ticket later has the same digest; an edited ticket has another', async () => {
    connect('server');
    stubApi([[/issue\/PROJ-12/, { body: ISSUE }]]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    const first = (await snapshot('PROJ-12')).body;
    vi.setSystemTime(9_000);
    const again = (await snapshot('PROJ-12')).body;
    expect(first.fetchedAt).toBe(1_000);
    expect(again.fetchedAt).toBe(9_000);
    expect(again.digest).toBe(first.digest);
    vi.unstubAllGlobals();
    stubApi([
      [
        /issue\/PROJ-12/,
        { body: { ...ISSUE, fields: { ...ISSUE.fields, description: 'Другое описание.' } } },
      ],
    ]);
    expect((await snapshot('PROJ-12')).body.digest).not.toBe(first.digest);
  });

  it('cloud: ADF description and an ADF checklist AC field read as text lines', async () => {
    connect('cloud', 'https://acme.atlassian.net');
    const doc = (lines: string[]) => ({
      type: 'doc',
      version: 1,
      content: lines.map((line) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: line }],
      })),
    });
    const api = stubApi([
      [
        /\/rest\/api\/3\/issue\/PROJ-7\?expand=names$/,
        {
          body: {
            key: 'PROJ-7',
            fields: {
              summary: 'Облако',
              description: doc(['Шаг один', 'Шаг два']),
              customfield_1: doc(['1. Первый критерий', '[ ] Второй критерий']),
            },
            names: { customfield_1: 'Критерии приёмки' },
          },
        },
      ],
    ]);
    const { status, body } = await snapshot('PROJ-7');
    expect(status).toBe(200);
    expect(body.body).toBe('Шаг один\nШаг два');
    expect(body.acceptance).toEqual(['Первый критерий', 'Второй критерий']);
    expect((api.calls[0]?.init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('no AC field: no acceptance (prose criteria are the model’s, not the tracker’s)', async () => {
    connect('server');
    const { customfield_10042: _ac, ...fields } = ISSUE.fields;
    stubApi([[/issue\/PROJ-12/, { body: { ...ISSUE, fields } }]]);
    const { status, body } = await snapshot('PROJ-12');
    expect(status).toBe(200);
    expect(body.acceptance).toBeUndefined();
  });

  it('a field that only mentions acceptance or criteria is not the AC field', async () => {
    connect('server');
    stubApi([
      [
        /issue\/PROJ-12/,
        {
          body: {
            ...ISSUE,
            fields: {
              ...ISSUE.fields,
              customfield_10042: '- Кнопка видна на странице отчёта',
              customfield_20001: '2026-11-20',
              customfield_20002: 'Согласовано заказчиком',
              customfield_20003: 'Высокая',
              customfield_20004: '- Второй критерий приёмки',
            },
            names: {
              customfield_10042: 'Acceptance Criteria',
              customfield_20001: 'Acceptance Date',
              customfield_20002: 'UAT acceptance status',
              customfield_20003: 'Критерий сложности',
              customfield_20004: 'Критерии приемки (DoD)',
            },
          },
        },
      ],
    ]);
    const { status, body } = await snapshot('PROJ-12');
    expect(status).toBe(200);
    // Дата, статус приёмки и «критерий сложности» — не критерии: структурные критерии решают
    // самоприём карточки (P133), чужая строка в них выглядела бы требованием тикета.
    expect(body.acceptance).toEqual(['Кнопка видна на странице отчёта', 'Второй критерий приёмки']);
  });

  it('over 100 AC lines: 100 sent and the total named in the fields', async () => {
    connect('server');
    const many = Array.from({ length: 130 }, (_, i) => `- критерий ${i + 1}`).join('\n');
    stubApi([
      [
        /issue\/PROJ-12/,
        { body: { ...ISSUE, fields: { ...ISSUE.fields, customfield_10042: many } } },
      ],
    ]);
    const { status, body } = await snapshot('PROJ-12');
    expect(status).toBe(200);
    expect(body.acceptance).toHaveLength(100);
    expect(body.fields?.acceptanceTotal).toBe(130);
  });

  it('a non-key never reaches the tracker: 400 naming the field', async () => {
    connect('server');
    const api = stubApi([]);
    const { status, body } = await snapshot('../../myself');
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_body');
    // Отказ едет с кодом: английский интерфейс переводит его, а не показывает русскую строку.
    expect(body).toMatchObject({
      messageCode: 'request-tracker-key-invalid',
      params: { field: 'key' },
    });
    expect(api.calls).toHaveLength(0);
  });

  it('no key at all: 400 by code naming the field, no request', async () => {
    connect('server');
    const api = stubApi([]);
    const { status, body } = await snapshot('  ');
    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'invalid_body',
      messageCode: 'request-tracker-key-missing',
      params: { field: 'key' },
    });
    expect(api.calls).toHaveLength(0);
  });

  it('Jira not connected: refusal by code, no request', async () => {
    const api = stubApi([]);
    const { status, body } = await snapshot('PROJ-12');
    expect(status).toBe(404);
    expect(body.code).toBe('integration_not_found');
    expect(api.calls).toHaveLength(0);
  });

  it('Jira answers 200 with an empty body: a named refusal, not a crash', async () => {
    connect('server');
    stubApi([[/issue\/PROJ-12/, { status: 200 }]]);
    const { status, body } = await snapshot('PROJ-12');
    expect(status).toBe(502);
    expect(body.digest).toBeUndefined();
    expect(String((body as { message?: string }).message)).toContain('Jira');
    expect(body).toMatchObject({
      messageCode: 'integration-issue-empty',
      params: { system: 'Jira', key: 'PROJ-12' },
    });
  });

  it('ticket missing in Jira: the refusal passes, no snapshot', async () => {
    connect('server');
    stubApi([]);
    const { status, body } = await snapshot('PROJ-404');
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.digest).toBeUndefined();
  });
});
