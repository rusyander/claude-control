import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store.ts';
import { checkIntegration } from './check.ts';
import { describeLink, dropLink, linkForCwd, readLinks, writeLink } from './links.ts';
import { readHealth, saveHealth } from './health.ts';
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
      'atlassian',
      'forge',
      'telegram',
      'tms',
      'ci',
      'webhook',
    ]);
    expect(cards.every((card) => card.hasToken === false && card.state === 'unchecked')).toBe(true);
  });

  it('идентификаторы токенов лежат в своём пространстве', () => {
    expect(tokenId('atlassian')).toBe('int:atlassian');
    expect(isIntegrationId('atlassian')).toBe(true);
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
    expect(all.atlassian.enabled).toBe(false);
    expect(all.ci.workflow).toBe('');
  });

  it('пустая строка стирает токен — это «выкинуть ключ», а не пустое сохранение', () => {
    writeToken(dir, 'atlassian', SECRET);
    expect(readToken(dir, 'atlassian')).toBe(SECRET);
    writeToken(dir, 'atlassian', '');
    expect(readToken(dir, 'atlassian')).toBeUndefined();
  });

  it('слишком длинный токен не принимается — 400 с именем поля', () => {
    expect(() => writeToken(dir, 'atlassian', 'x'.repeat(100_000))).toThrow(
      expect.objectContaining({ code: 'invalid_body', detail: 'token' }),
    );
  });

  it('выключенная интеграция или отсутствующий токен — честное 404, а не «сломалось»', () => {
    expect(() => requireConnected(store, dir, 'atlassian', 'Atlassian')).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
    writeToken(dir, 'atlassian', SECRET);
    expect(() => requireConnected(store, dir, 'atlassian', 'Atlassian')).toThrow(/не подключена/);

    writeSettings(store, 'atlassian', {
      ...readIntegrations(store).atlassian,
      enabled: true,
    });
    expect(requireConnected(store, dir, 'atlassian', 'Atlassian')).toBe(SECRET);
  });

  it('«забыть» снимает токен и гасит карточку, но адрес оставляет', () => {
    writeSettings(store, 'atlassian', {
      enabled: true,
      baseUrl: 'https://acme.atlassian.net',
      email: 'qa@acme.io',
      deployment: 'cloud',
      confluenceUrl: '',
    });
    writeToken(dir, 'atlassian', SECRET);
    saveHealth(store, 'atlassian', { state: 'ok', detail: 'Вошли как Ольга' });

    const card = forgetIntegration(store, dir, 'atlassian');
    expect(card).toMatchObject({ enabled: false, hasToken: false, state: 'unchecked' });
    // Человек снял ключ, а не переехал на другой сайт — адрес вводить заново незачем.
    expect(readIntegrations(store).atlassian.baseUrl).toBe('https://acme.atlassian.net');
    expect(readHealth(store, 'atlassian')).toBeUndefined();
  });
});

describe('domains/integrations/health: итог проверки переживает F5', () => {
  it('запись ложится на диск и читается обратно', () => {
    saveHealth(store, 'forge', { state: 'error', detail: 'токен отклонён' });
    const reread = new AppStore(dir);
    expect(readHealth(reread, 'forge')).toMatchObject({
      state: 'error',
      detail: 'токен отклонён',
    });
    expect(readHealth(reread, 'forge')?.checkedAt).toBeTruthy();
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
    writeLink(store, project, undefined, { jiraProjectKey: 'GOR', jiraIssueKey: 'PRJ-1' });
    writeLink(store, project, 'smoke', { jiraIssueKey: 'PRJ-99' });

    const links = readLinks(store, project);
    expect(links.project.jiraIssueKey).toBe('PRJ-1');
    expect(links.groups.smoke?.jiraIssueKey).toBe('PRJ-99');

    const found = linkForCwd(store, project, 'smoke');
    expect(found?.link).toMatchObject({ jiraProjectKey: 'GOR', jiraIssueKey: 'PRJ-99' });
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

  it('строка для агента собирается только из заполненного', () => {
    expect(
      describeLink({ jiraIssueKey: 'PRJ-1', jiraIssueTitle: 'Логин', confluencePageId: '12' }),
    ).toBe('задача PRJ-1 — Логин; страница Confluence 12');
    expect(describeLink({})).toBe('');
  });
});

describe('СЕКРЕТ НЕ ПОКИДАЕТ ХРАНИЛИЩА', () => {
  beforeEach(() => {
    writeSettings(store, 'atlassian', {
      enabled: true,
      baseUrl: 'https://acme.atlassian.net',
      email: 'qa@acme.io',
      deployment: 'cloud',
      confluenceUrl: '',
    });
    writeToken(dir, 'atlassian', SECRET);
  });

  it('карточка отдаёт маску, а не ключ', () => {
    const card = describeIntegration(store, dir, 'atlassian');
    expect(card.hasToken).toBe(true);
    expect(card.maskedToken).not.toContain(SECRET);
    expect(card.maskedToken).toContain('…');
    expect(JSON.stringify(card)).not.toContain(SECRET);
  });

  it('ни один из пяти ответов списка не содержит ключа', () => {
    expect(JSON.stringify(describeIntegrations(store, dir))).not.toContain(SECRET);
  });

  it('удачная проверка связи: ни в ответе, ни в state.json ключа нет', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(JSON.stringify({ displayName: 'Ольга' }), { status: 200 })),
    );
    const card = await checkIntegration(store, dir, 'atlassian');
    expect(card.state).toBe('ok');
    expect(card.account).toBe('Ольга');
    expect(card.deployment).toBe('cloud');
    expect(JSON.stringify(card)).not.toContain(SECRET);
    expect(everythingOnDisk(dir)).not.toContain(SECRET);
  });

  it('отказ 401 читается как «токен отклонён» и тоже не выносит ключ наружу', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('denied', { status: 401 })));
    const card = await checkIntegration(store, dir, 'atlassian');
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
    const card = await checkIntegration(store, dir, 'forge');
    expect(card.state).toBe('error');
    expect(card.detail).toBe('Токен не сохранён.');
    expect(calls).toHaveLength(0);
  });

  it('определённый диалект запоминается — иначе Confluence ищется не по тем путям', async () => {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(
        String(url).includes('/rest/api/3/')
          ? new Response('nope', { status: 404 })
          : new Response(JSON.stringify({ name: 'qa' }), { status: 200 }),
      ),
    );
    await checkIntegration(store, dir, 'atlassian');
    expect(readIntegrations(store).atlassian.deployment).toBe('server');
  });
});
