import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { readIntegrations, readToken } from '../store/store.ts';
import { applyDiscovered, discoverIntegrations, type DiscoverDeps } from './discover.ts';

/**
 * «Найти уже подключённые»: что узнаётся в записях MCP-серверов человека.
 *
 * Записи — настоящие файлы во временном каталоге в тех формах, в которых их
 * пишут: `docker run -e`, `npx` с `env`, адрес с заголовком, обёртка перед
 * запускателем, `.mcp.json` проекта. Главное свойство — ключ не выходит
 * наружу ни в одном ответе поиска: только маска.
 */

let dir: string;
let store: AppStore;

const deps = (): DiscoverDeps => ({
  paths: {
    mcpConfig: join(dir, '.claude.json'),
    settings: join(dir, 'settings.json'),
    settingsLocal: join(dir, 'settings.local.json'),
    secretsEnv: join(dir, '.mcp-secrets.env'),
  },
  store,
  appDataDir: dir,
});

// Ключи из кусков: литерал целиком похож на настоящий, и сторож его не пропустит.
const KEY = (name: string): string => ['value', name, '7f3a91c2'].join('-');

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(join(dir, '.claude.json'), JSON.stringify(config), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-discover-'));
  store = new AppStore(dir);
  // Окружение машины, на которой идёт прогон, не должно подмешиваться в находки.
  for (const name of [
    'GITHUB_TOKEN',
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'GITLAB_PERSONAL_ACCESS_TOKEN',
    'JIRA_URL',
    'JIRA_API_TOKEN',
  ]) {
    vi.stubEnv(name, '');
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('discover: формы запуска', () => {
  it('docker run -e ИМЯ=значение: облако Atlassian с почтой', () => {
    writeConfig({
      mcpServers: {
        atl: {
          command: 'docker',
          args: [
            'run',
            '-i',
            '--rm',
            '-e',
            'JIRA_URL=https://acme.atlassian.net',
            '-e',
            'JIRA_USERNAME=qa@acme.io',
            '-e',
            `JIRA_API_TOKEN=${KEY('jira')}`,
            'ghcr.io/sooperset/mcp-atlassian:latest',
          ],
        },
      },
    });
    const { found } = discoverIntegrations(deps());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: 'jira',
      launch: 'docker',
      package: 'ghcr.io/sooperset/mcp-atlassian:latest',
      fields: { baseUrl: 'https://acme.atlassian.net', email: 'qa@acme.io', deployment: 'cloud' },
      missing: [],
      hasToken: true,
    });
    expect(JSON.stringify(found)).not.toContain(KEY('jira'));
    expect(found[0]!.maskedToken).toContain('…');
  });

  it('npx через pnpm dlx с env и ссылкой ${VAR} на переменную настроек', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ env: { MY_GITLAB: KEY('gitlab') } }),
      'utf8',
    );
    writeConfig({
      mcpServers: {
        gl: {
          command: 'C:\\Program Files\\nodejs\\pnpm.cmd',
          args: ['dlx', '@zereight/mcp-gitlab'],
          env: {
            GITLAB_PERSONAL_ACCESS_TOKEN: '${MY_GITLAB}',
            GITLAB_API_URL: 'gitlab.acme.local/api/v4',
          },
        },
      },
    });
    const { found } = discoverIntegrations(deps());
    expect(found).toMatchObject([
      { id: 'gitlab', launch: 'npx', fields: { baseUrl: 'https://gitlab.acme.local' } },
    ]);
    applyDiscovered(deps(), [found[0]!.key]);
    expect(readToken(dir, 'gitlab')).toBe(KEY('gitlab'));
  });

  it('свой скрипт без узнаваемого пакета: ключ по списку MCP_SECRET_KEYS из файла секретов', () => {
    writeFileSync(
      join(dir, '.mcp-secrets.env'),
      `GITLAB_PERSONAL_ACCESS_TOKEN=${KEY('wrapped')}\n`,
      'utf8',
    );
    writeConfig({
      mcpServers: {
        mine: {
          command: 'node',
          args: ['C:/tools/mcp/my-server.mjs'],
          env: {
            MCP_SECRET_KEYS: 'GITLAB_PERSONAL_ACCESS_TOKEN',
            GITLAB_API_URL: 'https://gitlab.acme.local/api/v4',
          },
        },
      },
    });
    const { found } = discoverIntegrations(deps());
    expect(found).toMatchObject([{ id: 'gitlab', launch: 'command', hasToken: true }]);
    applyDiscovered(deps(), [found[0]!.key]);
    expect(readToken(dir, 'gitlab')).toBe(KEY('wrapped'));
  });

  it('удалённый сервер: ключ из заголовка, gitlab.com — облако без адреса', () => {
    writeFileSync(join(dir, '.mcp-secrets.env'), `GL=${KEY('remote')}\n`, 'utf8');
    writeConfig({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://gitlab.com/api/v4/mcp',
          headers: { Authorization: 'Bearer ${GL}' },
        },
      },
    });
    const { found } = discoverIntegrations(deps());
    expect(found).toMatchObject([{ id: 'gitlab', launch: 'url', fields: {}, hasToken: true }]);
    applyDiscovered(deps(), [found[0]!.key]);
    expect(readToken(dir, 'gitlab')).toBe(KEY('remote'));
  });

  it('флаги сервера (--jira-url) читаются как переменные; uvx --from — пакет', () => {
    writeConfig({
      mcpServers: {
        atl: {
          command: 'uvx',
          args: [
            '--from',
            'mcp-atlassian==0.11',
            'mcp-atlassian',
            '--confluence-url=https://wiki.acme.local',
            '--confluence-personal-token',
            KEY('wiki'),
          ],
        },
      },
    });
    const { found } = discoverIntegrations(deps());
    // Jira у этого сервера не настроена — кандидата на неё нет.
    expect(found).toMatchObject([
      {
        id: 'confluence',
        launch: 'uvx',
        package: 'mcp-atlassian==0.11',
        fields: { baseUrl: 'https://wiki.acme.local', deployment: 'server' },
      },
    ]);
  });

  it('свой переходник панели и чужая переменная окружения машины — не находки', () => {
    vi.stubEnv('GITHUB_TOKEN', KEY('machine'));
    writeConfig({
      mcpServers: {
        mine: {
          command: 'node',
          args: ['C:/work/agentdeck/tools/mcp/atlassian.mjs'],
          env: { AGENTDECK_URL: 'http://127.0.0.1:5178' },
        },
        // Сервер не GitHub: GITHUB_TOKEN машины его GitHub-ом не делает.
        files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
      },
    });
    expect(discoverIntegrations(deps())).toEqual({ scanned: 1, found: [] });
  });

  it('проекты: блок проекта в ~/.claude.json и .mcp.json; один доступ дважды — одна находка', () => {
    const project = join(dir, 'repo');
    mkdirSync(project);
    const server = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: KEY('gh') },
    };
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { gh: server } }));
    writeConfig({ mcpServers: { gh: server }, projects: { [project]: { mcpServers: {} } } });
    const { found, scanned } = discoverIntegrations(deps());
    expect(scanned).toBe(2);
    expect(found).toMatchObject([{ id: 'github', source: 'user', fields: {} }]);
  });
});

describe('discover: перенос', () => {
  const telegram = (chatId?: string) => ({
    command: 'npx',
    args: ['-y', 'mcp-telegram'],
    env: { TELEGRAM_BOT_TOKEN: KEY('bot'), ...(chatId ? { TELEGRAM_CHAT_ID: chatId } : {}) },
  });

  it('неполная находка видна с тем, чего не хватает, и не переносится', () => {
    writeConfig({ mcpServers: { tg: telegram() } });
    const { found } = discoverIntegrations(deps());
    expect(found[0]).toMatchObject({ id: 'telegram', missing: ['chatId'] });
    expect(() => applyDiscovered(deps(), [found[0]!.key])).toThrow(
      expect.objectContaining({ messageCode: 'integration-discover-incomplete' }),
    );
    expect(readToken(dir, 'telegram')).toBeUndefined();
  });

  it('два сервера на одну интеграцию — отказ до единой записи', () => {
    writeConfig({
      mcpServers: {
        a: { command: 'npx', args: ['@zereight/mcp-gitlab'], env: { GITLAB_TOKEN: KEY('a') } },
        b: { command: 'npx', args: ['@zereight/mcp-gitlab'], env: { GITLAB_TOKEN: KEY('b') } },
        tg: telegram('@qa'),
      },
    });
    const { found } = discoverIntegrations(deps());
    expect(() =>
      applyDiscovered(
        deps(),
        found.map((item) => item.key),
      ),
    ).toThrow(expect.objectContaining({ messageCode: 'integration-discover-twice' }));
    expect(readToken(dir, 'telegram')).toBeUndefined();
    expect(readIntegrations(store).telegram.enabled).toBe(false);
  });

  it('замена другого доступа помечена, тот же доступ — «уже подключено»', () => {
    writeConfig({ mcpServers: { tg: telegram('@qa') } });
    const first = discoverIntegrations(deps()).found[0]!;
    expect(first).toMatchObject({ alreadyConnected: false, replaces: false });

    applyDiscovered(deps(), [first.key]);
    expect(readIntegrations(store).telegram).toMatchObject({ enabled: true, chatId: '@qa' });
    expect(discoverIntegrations(deps()).found[0]).toMatchObject({ alreadyConnected: true });

    writeConfig({ mcpServers: { tg: telegram('@other') } });
    expect(discoverIntegrations(deps()).found[0]).toMatchObject({
      alreadyConnected: false,
      replaces: true,
    });
  });
});
