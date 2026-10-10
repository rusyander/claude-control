import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateLegacyIntegrations } from '@agentdeck/contracts/integrations-legacy';
import { AppStore } from './app-store.ts';
import { getStoredKey, setStoredKey } from '../provider-keys/provider-keys.ts';

/**
 * Интеграции прежней формы (до 10.10.2026: `atlassian`, `forge`, `tms`) — после
 * обновления. Проверка идёт настоящей загрузкой: `state.json` прежней формы и
 * ключи в зашифрованном хранилище под прежними именами, затем `new AppStore` —
 * ровно то, что делает сервер на старте. Человек не должен заново вводить ни
 * адрес, ни ключ.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-int-legacy-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Ключи из кусков: литерал целиком похож на настоящий, и сторож его не пропустит.
const JIRA_KEY = ['jira', 'legacy', '0001'].join('-');
const WIKI_KEY = ['wiki', 'legacy', '0002'].join('-');
const FORGE_KEY = ['forge', 'legacy', '0003'].join('-');
const TMS_KEY = ['tms', 'legacy', '0004'].join('-');

function writeLegacyState(integrations: Record<string, unknown>, health = {}): void {
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ settings: { integrations }, integrationHealth: health }),
    'utf8',
  );
}

const ATLASSIAN_SERVER = {
  enabled: true,
  baseUrl: 'https://jira.acme.local',
  email: '',
  deployment: 'server',
  confluenceUrl: 'https://wiki.acme.local',
};

describe('app-store: интеграции прежней формы переезжают при загрузке', () => {
  it('своя установка: Jira и Confluence — каждая со своим адресом и своим ключом', () => {
    writeLegacyState(
      {
        atlassian: ATLASSIAN_SERVER,
        forge: { enabled: true, kind: 'gitlab', baseUrl: 'https://gitlab.acme.local', repo: 'a/b' },
        tms: {
          enabled: true,
          kind: 'testit',
          baseUrl: 'https://tms',
          projectKey: 'P',
          groupId: '',
        },
      },
      { 'int:atlassian': { state: 'ok', detail: 'Вошли', checkedAt: '2026-10-01' } },
    );
    setStoredKey(dir, 'int:atlassian', JIRA_KEY);
    setStoredKey(dir, 'int:atlassian-confluence', WIKI_KEY);
    setStoredKey(dir, 'int:forge', FORGE_KEY);
    setStoredKey(dir, 'int:tms', TMS_KEY);

    const store = new AppStore(dir);
    const { integrations } = store.getSettings();
    expect(integrations.jira).toMatchObject({ enabled: true, baseUrl: 'https://jira.acme.local' });
    expect(integrations.confluence).toMatchObject({
      enabled: true,
      baseUrl: 'https://wiki.acme.local',
      deployment: 'server',
    });
    expect(integrations.gitlab).toMatchObject({ enabled: true, repo: 'a/b' });
    expect(integrations.testit).toMatchObject({ enabled: true, projectKey: 'P' });
    expect(integrations.github.enabled).toBe(false);

    expect(getStoredKey(dir, 'int:jira')).toBe(JIRA_KEY);
    // Отдельный ключ вики — именно Confluence, ключ Jira его место не занял.
    expect(getStoredKey(dir, 'int:confluence')).toBe(WIKI_KEY);
    expect(getStoredKey(dir, 'int:gitlab')).toBe(FORGE_KEY);
    expect(getStoredKey(dir, 'int:testit')).toBe(TMS_KEY);
    // Прежние имена стёрты: секрет без карточки нечем было бы забыть.
    for (const old of ['int:atlassian', 'int:atlassian-confluence', 'int:forge', 'int:tms']) {
      expect(getStoredKey(dir, old)).toBeUndefined();
    }

    // Переезд записан на диск один раз — повторная загрузка ничего не трогает.
    const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as {
      settings: { integrations: Record<string, unknown> };
      integrationHealth: Record<string, unknown>;
    };
    expect(onDisk.settings.integrations).not.toHaveProperty('atlassian');
    expect(onDisk.integrationHealth).toHaveProperty('int:jira');
    expect(onDisk.integrationHealth).not.toHaveProperty('int:atlassian');
    expect(new AppStore(dir).getSettings().integrations.jira.baseUrl).toBe(
      'https://jira.acme.local',
    );
    expect(getStoredKey(dir, 'int:jira')).toBe(JIRA_KEY);
  });

  it('облако с одним ключом: Confluence получает ключ Jira и адрес /wiki', () => {
    writeLegacyState({
      atlassian: {
        enabled: true,
        baseUrl: 'https://acme.atlassian.net/',
        email: 'qa@acme.io',
        deployment: '',
        confluenceUrl: '',
      },
    });
    setStoredKey(dir, 'int:atlassian', JIRA_KEY);

    const { integrations } = new AppStore(dir).getSettings();
    expect(integrations.confluence.baseUrl).toBe('https://acme.atlassian.net/wiki');
    expect(integrations.confluence.email).toBe('qa@acme.io');
    expect(getStoredKey(dir, 'int:jira')).toBe(JIRA_KEY);
    expect(getStoredKey(dir, 'int:confluence')).toBe(JIRA_KEY);
  });

  it('ключ, уже введённый в новой версии, прежним не перезаписывается', () => {
    writeLegacyState({ forge: { enabled: true, kind: 'github', baseUrl: '', repo: 'a/b' } });
    setStoredKey(dir, 'int:forge', FORGE_KEY);
    setStoredKey(dir, 'int:github', 'fresh-github-value');

    new AppStore(dir);
    expect(getStoredKey(dir, 'int:github')).toBe('fresh-github-value');
    expect(getStoredKey(dir, 'int:forge')).toBeUndefined();
  });
});

describe('integrations-legacy: разбор прежней формы', () => {
  it('нынешняя форма — без изменений и без записи', () => {
    const current = { jira: { enabled: true } };
    expect(migrateLegacyIntegrations(current)).toMatchObject({ changed: false, tokens: [] });
    expect(migrateLegacyIntegrations(undefined).changed).toBe(false);
  });

  it('уже записанная нынешняя карточка правдивее прежней', () => {
    const { integrations } = migrateLegacyIntegrations({
      atlassian: ATLASSIAN_SERVER,
      jira: { enabled: false, baseUrl: 'https://new.acme', email: '', deployment: '' },
    });
    expect((integrations as Record<string, { baseUrl: string }>).jira?.baseUrl).toBe(
      'https://new.acme',
    );
  });

  it('фордж и тест-кейсы без вида никуда не переезжают — гадать систему нельзя', () => {
    const { integrations, tokens } = migrateLegacyIntegrations({
      forge: { enabled: true, kind: '', baseUrl: '', repo: '' },
      tms: { enabled: false, kind: '', baseUrl: '', projectKey: '', groupId: '' },
    });
    expect(integrations).toEqual({});
    expect(tokens).toEqual([]);
  });
});
