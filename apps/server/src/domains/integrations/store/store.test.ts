import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { checkIntegration } from '../check.ts';
import { dropLink, linkForCwd, readLinks, writeLink } from '../links.ts';
import { readHealth, saveHealth } from '../health.ts';
import {
  describeIntegration,
  describeIntegrations,
  forgetIntegration,
  isIntegrationId,
  readIntegrations,
  readToken,
  requireConnected,
  tokenId,
  writeSettings,
  writeToken,
} from './store.ts';

/**
 * Хранилище интеграций: настройка видна, ТОКЕН НЕ ВИДЕН НИКОМУ.
 *
 * Главная проверка файла — последняя группа: сохранённый токен не должен
 * появиться ни в одном ответе панели, ни в `state.json`, ни в записи о проверке
 * связи. Это то единственное свойство, ради которого секреты вообще вынесены в
 * отдельное зашифрованное хранилище.
 */

const SECRET = 'ATLASSIAN-TOKEN-9f3a7c1e-СЕКРЕТ';

let dir: string;
let store: AppStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-int-'));
  store = new AppStore(dir);
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** Всё, что панель записала на диск, одной строкой — для поиска утечки. */
function everythingOnDisk(root: string): string {
  const parts: string[] = [];
  const walk = (path: string): void => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else parts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return parts.join('\n');
}

describe('domains/integrations/store: настройки и токены', () => {
  it('карточки показываются всегда, даже пустыми', () => {
    const cards = describeIntegrations(store, dir);
    expect(cards.map((card) => card.id)).toEqual([
      'jira',
      'confluence',
      'gitlab',
      'github',
      'telegram',
      'zephyr',
      'xray',
      'testit',
      'ci',
      'webhook',
    ]);
    expect(cards.every((card) => card.hasToken === false && card.state === 'unchecked')).toBe(true);
  });

  it('идентификаторы токенов лежат в своём пространстве', () => {
    expect(tokenId('jira')).toBe('int:jira');
    expect(isIntegrationId('jira')).toBe(true);
    expect(isIntegrationId('anthropic')).toBe(false);
  });

  it('настройка одной карточки не трогает соседние', () => {
    writeSettings(store, 'telegram', {
      enabled: true,
      chatId: '@qa',
      events: ['testFailed'],
    });
    const all = readIntegrations(store);
    expect(all.telegram.chatId).toBe('@qa');
    expect(all.jira.enabled).toBe(false);
    expect(all.ci.workflow).toBe('');
  });

  it('пустая строка стирает токен — это «выкинуть ключ», а не пустое сохранение', () => {
    writeToken(dir, 'jira', SECRET);
    expect(readToken(dir, 'jira')).toBe(SECRET);
    writeToken(dir, 'jira', '');
    expect(readToken(dir, 'jira')).toBeUndefined();
  });

  it('слишком длинный токен не принимается — 400 с именем поля', () => {
    expect(() => writeToken(dir, 'jira', 'x'.repeat(100_000))).toThrow(
      expect.objectContaining({ code: 'invalid_body', detail: 'token' }),
    );
  });

  it('выключенная интеграция или отсутствующий токен — честное 404, а не «сломалось»', () => {
    expect(() => requireConnected(store, dir, 'jira', 'Jira')).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
    writeToken(dir, 'jira', SECRET);
    expect(() => requireConnected(store, dir, 'jira', 'Jira')).toThrow(/не подключена/);

    writeSettings(store, 'jira', {
      ...readIntegrations(store).jira,
      enabled: true,
    });
    expect(requireConnected(store, dir, 'jira', 'Jira')).toBe(SECRET);
  });

  it('«забыть» снимает токен и гасит карточку, но адрес оставляет', () => {
    writeSettings(store, 'jira', {
      enabled: true,
      baseUrl: 'https://acme.jira.net',
      email: 'qa@acme.io',
      deployment: 'cloud',
    });
    writeToken(dir, 'jira', SECRET);
    saveHealth(store, 'jira', { state: 'ok', detail: 'Вошли как Ольга' });

    const card = forgetIntegration(store, dir, 'jira');
    expect(card).toMatchObject({ enabled: false, hasToken: false, state: 'unchecked' });
    // Человек снял ключ, а не переехал на другой сайт — адрес вводить заново незачем.
    expect(readIntegrations(store).jira.baseUrl).toBe('https://acme.jira.net');
    expect(readHealth(store, 'jira')).toBeUndefined();
  });
});

describe('domains/integrations/health: итог проверки переживает F5', () => {
  it('запись ложится на диск и читается обратно', () => {
    saveHealth(store, 'gitlab', { state: 'error', detail: 'токен отклонён' });
    const reread = new AppStore(dir);
    expect(readHealth(reread, 'gitlab')).toMatchObject({
      state: 'error',
      detail: 'токен отклонён',
    });
    expect(readHealth(reread, 'gitlab')?.checkedAt).toBeTruthy();
  });
});

describe('domains/integrations/links: привязка проекта', () => {
  const project = join(dir || tmpdir(), 'repo');

  it('пустой путь — 400 с именем поля', () => {
    expect(() => readLinks(store, '   ')).toThrow(
      expect.objectContaining({ code: 'invalid_body', detail: 'path' }),
    );
  });

  it('привязка проекта и привязка группы живут отдельно, группа сильнее', () => {
    writeLink(store, project, undefined, { jiraProjectKey: 'PRJ', jiraIssueKey: 'PRJ-1' });
    writeLink(store, project, 'smoke', { jiraIssueKey: 'PRJ-99' });

    const links = readLinks(store, project);
    expect(links.project.jiraIssueKey).toBe('PRJ-1');
    expect(links.groups.smoke?.jiraIssueKey).toBe('PRJ-99');

    const found = linkForCwd(store, project, 'smoke');
    expect(found?.link).toMatchObject({ jiraProjectKey: 'PRJ', jiraIssueKey: 'PRJ-99' });
  });

  it('копия ветки — тот же проект: тикет от смены ветки не меняется', () => {
    writeLink(store, project, undefined, { jiraIssueKey: 'PRJ-1' });
    const worktree = `${project}-worktrees/feature-x`;
    expect(linkForCwd(store, worktree)?.link.jiraIssueKey).toBe('PRJ-1');
    expect(linkForCwd(store, join(project, 'apps', 'web'))?.link.jiraIssueKey).toBe('PRJ-1');
  });

  it('чужой каталог не подхватывает чужую привязку', () => {
    writeLink(store, project, undefined, { jiraIssueKey: 'PRJ-1' });
    expect(linkForCwd(store, join(dir, 'other'))).toBeUndefined();
    expect(linkForCwd(store, '')).toBeUndefined();
  });

  it('снятая привязка исчезает целиком, а не остаётся пустым объектом', () => {
    writeLink(store, project, undefined, { jiraIssueKey: 'PRJ-1' });
    dropLink(store, project, undefined);
    expect(readLinks(store, project)).toEqual({ project: {}, groups: {} });
    expect(linkForCwd(store, project)).toBeUndefined();
  });
});

describe('СЕКРЕТ НЕ ПОКИДАЕТ ХРАНИЛИЩА', () => {
  beforeEach(() => {
    writeSettings(store, 'jira', {
      enabled: true,
      baseUrl: 'https://acme.jira.net',
      email: 'qa@acme.io',
      deployment: 'cloud',
    });
    writeToken(dir, 'jira', SECRET);
  });

  it('карточка отдаёт маску, а не ключ', () => {
    const card = describeIntegration(store, dir, 'jira');
    expect(card.hasToken).toBe(true);
    expect(card.maskedToken).not.toContain(SECRET);
    expect(card.maskedToken).toContain('…');
    expect(JSON.stringify(card)).not.toContain(SECRET);
  });

  it('ни один из ответов списка не содержит ключа', () => {
    expect(JSON.stringify(describeIntegrations(store, dir))).not.toContain(SECRET);
  });

  it('удачная проверка связи: ни в ответе, ни в state.json ключа нет', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ displayName: 'Ольга' }), { status: 200 })),
    );
    const card = await checkIntegration(store, dir, 'jira');
    expect(card.state).toBe('ok');
    expect(card.account).toBe('Ольга');
    expect(card.deployment).toBe('cloud');
    expect(JSON.stringify(card)).not.toContain(SECRET);
    expect(everythingOnDisk(dir)).not.toContain(SECRET);
  });

  it('отказ 401 читается как «токен отклонён» и тоже не выносит ключ наружу', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('denied', { status: 401 })));
    const card = await checkIntegration(store, dir, 'jira');
    expect(card.state).toBe('error');
    expect(card.detail).toContain('токен отклонён');
    expect(JSON.stringify(card)).not.toContain(SECRET);
    expect(everythingOnDisk(dir)).not.toContain(SECRET);
  });

  it('проверка без токена — «Токен не сохранён», а не запрос наружу', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(String(url));
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const card = await checkIntegration(store, dir, 'gitlab');
    expect(card.state).toBe('error');
    expect(card.detail).toBe('Токен не сохранён.');
    expect(calls).toHaveLength(0);
  });

  /**
   * Каждая система проверяется у себя (владелец 10.10.2026). Дефект 18.09.2026:
   * Jira отвечала «Вошли как …», а Confluence на том же доступе — 401, и узнать
   * об этом можно было только нажав кнопку публикации.
   */
  it('проверка Jira не ходит в вики: о Confluence говорит её собственная карточка', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ displayName: 'Ольга' }), { status: 200 }),
      );
    });
    const card = await checkIntegration(store, dir, 'jira');
    expect(card.detail).toContain('Вошли как Ольга');
    expect(calls.every((url) => url.includes('/rest/api/3/myself'))).toBe(true);
  });

  it('Confluence спрашивается своим ключом и своим адресом — облако под /wiki', async () => {
    const wiki = 'WIKI-PAT-7b2c-СЕКРЕТ';
    writeSettings(store, 'confluence', {
      enabled: true,
      baseUrl: 'https://acme.jira.net',
      email: 'qa@acme.io',
      deployment: '',
    });
    writeToken(dir, 'confluence', wiki);
    const calls: { url: string; auth: string }[] = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers.Authorization ?? '' });
      return Promise.resolve(
        new Response(JSON.stringify({ displayName: 'Ольга' }), { status: 200 }),
      );
    });
    const card = await checkIntegration(store, dir, 'confluence');
    expect(card.state).toBe('ok');
    expect(calls[0]?.url).toBe('https://acme.jira.net/wiki/rest/api/user/current');
    // Ключ — свой, Confluence: ключом Jira вики отвечает 401 на рабочем доступе.
    expect(Buffer.from(calls[0]!.auth.replace('Basic ', ''), 'base64').toString()).toBe(
      `qa@acme.io:${wiki}`,
    );
    expect(readIntegrations(store).confluence.deployment).toBe('cloud');
    expect(JSON.stringify(card)).not.toContain(wiki);
    expect(everythingOnDisk(dir)).not.toContain(wiki);
  });

  it('Confluence отклонил ключ — красная его карточка, Jira остаётся зелёной', async () => {
    writeSettings(store, 'confluence', {
      enabled: true,
      baseUrl: 'https://wiki.acme.local',
      email: '',
      deployment: 'server',
    });
    writeToken(dir, 'confluence', 'WIKI-PAT');
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        String(url).includes('/rest/api/user/current')
          ? new Response('denied', { status: 401 })
          : new Response(JSON.stringify({ name: 'qa' }), { status: 200 }),
      ),
    );
    expect((await checkIntegration(store, dir, 'confluence')).state).toBe('error');
    expect((await checkIntegration(store, dir, 'jira')).state).toBe('ok');
  });

  it('определённый диалект запоминается — иначе Confluence ищется не по тем путям', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        String(url).includes('/rest/api/3/')
          ? new Response('nope', { status: 404 })
          : new Response(JSON.stringify({ name: 'qa' }), { status: 200 }),
      ),
    );
    await checkIntegration(store, dir, 'jira');
    expect(readIntegrations(store).jira.deployment).toBe('server');
  });
});
