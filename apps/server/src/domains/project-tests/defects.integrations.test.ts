import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestCase } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import { writeLink } from '../integrations/links.ts';
import { writeSettings, writeToken } from '../integrations/store.ts';
import { availableTargets, buildDraft, createTokenDefect, type DefectDeps } from './defects.ts';

/**
 * Дефект по подключённой интеграции: Jira по привязке и фордж по токену.
 *
 * `gh`/`glab` здесь не проверяются — они зависят от того, что стоит на машине, и
 * у них свой тест. Проверяем ровно новое: список назначений считается живым, а
 * проект Jira берётся ТОЛЬКО из привязки и никогда не угадывается.
 */

const CASE: ProjectTestCase = {
  id: 'gui-001',
  type: 'case',
  title: 'Вход с верными данными',
  area: 'Авторизация',
  steps: [{ action: 'открыть форму' }, { action: 'нажать «Войти»' }],
  expected: 'открылся кабинет',
  status: 'failed',
  source: 'human',
};

let dir: string;
let store: AppStore;

function stubApi(routes: [RegExp, { status?: number; body?: unknown }][]): {
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const found = routes.find(([pattern]) => pattern.test(String(url)));
    const reply = found?.[1] ?? { status: 404, body: {} };
    return Promise.resolve(
      new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
      }),
    );
  });
  return { calls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-defect-'));
  store = new AppStore(dir);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const project = (): string => join(dir, 'repo');
const deps = (): DefectDeps => ({ store, appDataDir: dir, root: project() });

function connectJira(): void {
  writeSettings(store, 'atlassian', {
    enabled: true,
    baseUrl: 'https://acme.atlassian.net',
    email: 'qa@acme.io',
    deployment: 'cloud',
    confluenceUrl: '',
  });
  writeToken(dir, 'atlassian', 'ATL-SECRET');
}

function connectForge(): void {
  writeSettings(store, 'forge', {
    enabled: true,
    kind: 'github',
    baseUrl: '',
    repo: 'acme/panel',
  });
  writeToken(dir, 'forge', 'GH-SECRET');
}

describe('project-tests/defects: черновик остаётся без интеграций', () => {
  it('текст собирается всегда — это половина работы тестировщика', () => {
    const draft = buildDraft(CASE, { groupId: 'gui', branch: 'qa/login', commit: 'abc123' });
    expect(draft.title).toBe('[Авторизация] Вход с верными данными');
    expect(draft.body).toContain('**Шаги**');
    expect(draft.body).toContain('1. открыть форму');
    expect(draft.body).toContain('**Ожидалось**');
    expect(draft.body).toContain('qa/login');
  });

  it('без подключённых систем список назначений не выдумывается', () => {
    // На машине разработчика `gh` может быть — проверяем отсутствие ИМЕННО
    // токенных путей, они не зависят от того, что стоит рядом.
    expect(availableTargets()).not.toContain('jira');
    expect(availableTargets()).not.toContain('forge');
  });
});

describe('project-tests/defects: назначения по токену', () => {
  it('Jira появляется только вместе с ПРИВЯЗКОЙ проекта, не с токеном', () => {
    connectJira();
    expect(availableTargets(deps())).not.toContain('jira');

    writeLink(store, project(), undefined, { jiraProjectKey: 'GOR' });
    expect(availableTargets(deps())).toContain('jira');
    expect(buildDraft(CASE, { groupId: 'gui', deps: deps() }).hint).toContain('Jira GOR');
  });

  it('фордж по токену не требует привязки — репозиторий у него в настройке', () => {
    connectForge();
    const targets = availableTargets(deps());
    expect(targets).toContain('forge');
    expect(buildDraft(CASE, { groupId: 'gui', deps: deps() }).hint).toContain('GitHub по токену');
  });

  it('выключенная карточка не даёт назначения, даже если ключ сохранён', () => {
    connectForge();
    writeSettings(store, 'forge', {
      enabled: false,
      kind: 'github',
      baseUrl: '',
      repo: 'acme/panel',
    });
    expect(availableTargets(deps())).not.toContain('forge');
  });

  it('Jira идёт первой: команда с трекером ждёт дефект именно там', () => {
    connectJira();
    connectForge();
    writeLink(store, project(), undefined, { jiraProjectKey: 'GOR' });
    const targets = availableTargets(deps());
    expect(targets.indexOf('jira')).toBeLessThan(targets.indexOf('forge'));
  });
});

describe('project-tests/defects: заведение по токену', () => {
  it('Jira: проект берётся из привязки, ссылка возвращается наружу', async () => {
    connectJira();
    writeLink(store, project(), undefined, { jiraProjectKey: 'GOR' });
    const { calls } = stubApi([
      [/rest\/api\/3\/issue$/, { body: { key: 'PRJ-5' } }],
      [/issue\/PRJ-5/, { body: { key: 'PRJ-5', fields: { summary: 'Дефект' } } }],
    ]);

    await expect(createTokenDefect(deps(), 'jira', 'Падает вход', 'шаги')).resolves.toBe(
      'https://acme.atlassian.net/browse/PRJ-5',
    );
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      fields: { project: { key: string } };
    };
    expect(body.fields.project.key).toBe('GOR');
  });

  it('Jira без привязки — отказ, а не дефект в чужом проекте', async () => {
    connectJira();
    const { calls } = stubApi([]);
    await expect(createTokenDefect(deps(), 'jira', 'x', 'y')).rejects.toThrow(
      /не привязан проект Jira/,
    );
    expect(calls).toHaveLength(0);
  });

  it('фордж: задача заводится по сохранённому токену', async () => {
    connectForge();
    stubApi([[/repos\/acme\/panel\/issues/, { body: { html_url: 'https://gh/3', number: 3 } }]]);
    await expect(createTokenDefect(deps(), 'forge', 'Падает', 'шаги')).resolves.toBe(
      'https://gh/3',
    );
  });

  it('фордж без токена — 404 «не подключена», а не запрос наружу', async () => {
    const { calls } = stubApi([]);
    await expect(createTokenDefect(deps(), 'forge', 'x', 'y')).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(calls).toHaveLength(0);
  });
});
