import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { blockLang } from '@agentdeck/contracts/brand';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { GroupAsk } from '../../domains/groups/model.ts';
import { registerAnalyticsRoutes } from '../analytics-routes.ts';
import { registerChatBrowseRoutes } from '../chat/browse-routes.ts';
import { registerConfigRoutes } from '../config-routes.ts';
import { registerProviderCheckRoutes } from '../provider-check-routes.ts';
import { registerIntegrationsRoutes } from '../integrations-routes.ts';
import { registerPortabilityRoutes } from '../portability-routes.ts';
import { registerGroupPathRoutes } from '../group-path-routes.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { HARNESS_ORIGIN, manageHarness, type ManageHarness } from './manage-test-harness.ts';

/**
 * Настройки, провайдер, интеграции, перенос и группы дорожки A — на настоящих
 * маршрутах и ВРЕМЕННОМ доме (HOME/USERPROFILE), как в тесте переноса. Подменены
 * только внешние границы: сеть прайса (снимок), Jira (http-стаб на 127.0.0.1) и
 * вызов модели сводки. Доказательства — что дошло до маршрута (тело проверки,
 * `refresh` прайса, вызовы стаба и модели) и файлы, а не текст ответа действия.
 */
const TOKEN_IN_FILE = 'sk-ant-oat01-CREDFILECREDFILECREDFILECREDFILE0000';
const ATLASSIAN_TOKEN = 'ATLASSIAN-PAT-HUMAN-ONLY-Lane-A';

async function startJira() {
  const calls: Array<{ method: string; path: string }> = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    calls.push({ method: request.method ?? '', path: url.pathname });
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    request.resume();
    request.on('end', () => {
      if (request.method !== 'GET') return send(405, { message: 'read-only stub' });
      if (url.pathname === '/rest/api/2/issue/PRJ-7/transitions') {
        return send(200, {
          transitions: [
            { id: '21', name: 'В работу' },
            { id: '31', name: 'Готово' },
          ],
        });
      }
      return send(404, { errorMessages: ['Issue does not exist'] });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('panel-agent actions: settings / provider / integrations / portability / groups gaps (lane A)', () => {
  const savedEnv = { ...process.env };
  let home: string;
  let appData: string;
  let claudeDir: string;
  let jira: Awaited<ReturnType<typeof startJira>>;
  let h: ManageHarness;
  let pricingForced: boolean[];
  let modelCalls: string[];
  /** Тела, дошедшие до маршрута проверки провайдера. */
  let checkBodies: unknown[];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cc-agent-gaps-s-home-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-gaps-s-data-'));
    for (const key of ['HOME', 'USERPROFILE']) process.env[key] = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.ANTHROPIC_API_KEY;
    // Предохранитель: дом ДОЛЖЕН быть временным — проверка провайдера и доступ
    // к аккаунту читают его.
    expect(homedir()).toBe(home);

    claudeDir = join(home, '.claude');
    mkdirSync(join(claudeDir, 'skills', 'ladder'), { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), '{"permissions":{"allow":["Bash(ls)"]}}\n');
    writeFileSync(join(claudeDir, 'CLAUDE.md'), 'Преамбула.\n');
    writeFileSync(
      join(claudeDir, 'skills', 'ladder', 'SKILL.md'),
      '---\nname: ladder\ndescription: ladder skill\n---\n\nДелает лестницу.\n',
    );
    writeFileSync(
      join(claudeDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: TOKEN_IN_FILE } }),
    );
    mkdirSync(join(home, 'work', 'shop'), { recursive: true });
    mkdirSync(join(home, 'work', '.hidden'), { recursive: true });

    jira = await startJira();
    pricingForced = [];
    modelCalls = [];
    checkBodies = [];
    const store = new AppStore(appData);
    store.addProject({ id: 'p-shop', name: 'shop', path: join(home, 'work', 'shop') });
    const snapshot = {
      entries: [
        {
          id: 'claude-test',
          label: 'Claude Test',
          price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
        },
      ],
      source: 'built-in' as const,
      fetchedAt: '2026-09-28T00:00:00.000Z',
    };
    const ctx = {
      store,
      backupDir: join(appData, 'backups'),
      location: {
        paths: {
          root: claudeDir,
          appData,
          settings: join(claudeDir, 'settings.json'),
          settingsLocal: join(claudeDir, 'settings.local.json'),
          claudeMd: join(claudeDir, 'CLAUDE.md'),
          skills: join(claudeDir, 'skills'),
          hooks: join(claudeDir, 'hooks'),
          mcpConfig: join(home, '.claude.json'),
          secretsEnv: join(claudeDir, '.mcp-secrets.env'),
        },
      },
      // Прайс с сайта — сеть: снимок и отметка, просили ли обновить силой.
      pricing: {
        refresh: async ({ force }: { force: boolean }) => {
          pricingForced.push(force);
          return snapshot;
        },
        lastError: () => undefined,
        isStale: () => false,
      },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    const ask: GroupAsk = async (messages) => {
      modelCalls.push(messages.map((message) => message.content).join('\n'));
      return [
        '```' + blockLang('resource-summary'),
        '{"ru":"Строит лестницу","en":"Builds a ladder"}',
        '```',
      ].join('\n');
    };
    h = await manageHarness(ctx, (app) => {
      app.addHook('preHandler', async (request) => {
        if (request.url.startsWith('/api/providers/') && request.method === 'POST') {
          checkBodies.push(request.body);
        }
      });
      registerProjectRoutes(app, ctx);
      registerAnalyticsRoutes(app, ctx);
      registerChatBrowseRoutes(app, ctx);
      registerConfigRoutes(app, ctx);
      registerProviderCheckRoutes(app, ctx);
      registerIntegrationsRoutes(app, ctx, 'http://127.0.0.1:5178');
      registerPortabilityRoutes(app, ctx);
      registerGroupPathRoutes(app, ctx, () => ask);
    });
  });

  afterEach(async () => {
    await h.close();
    await jira.close();
    for (const key of [
      'HOME',
      'USERPROFILE',
      'XDG_CONFIG_HOME',
      'APPDATA',
      'CLAUDE_CONFIG_DIR',
      'ANTHROPIC_API_KEY',
    ]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    for (const dir of [home, appData]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('read_model_pricing: prices and source without forcing a network refresh', async () => {
    const out = await h.call('read_model_pricing', {});
    expect(out.outcome, out.message).toBe('done');
    expect(out.result).toMatchObject({
      source: 'built-in',
      stale: false,
      entries: [{ id: 'claude-test', price: { input: 3, output: 15 } }],
    });
    // Сеть прайса трогает только кнопка человека: `refresh=true` не уходил.
    expect(pricingForced).toEqual([false]);
  });

  it('list_editors: known editors with installed flag, no shell command', async () => {
    const out = await h.call('list_editors', {});
    expect(out.outcome, out.message).toBe('done');
    const editors = (out.result as { editors: Array<Record<string, unknown>> }).editors;
    expect(editors.length).toBeGreaterThan(0);
    for (const editor of editors) {
      expect(Object.keys(editor).sort()).toEqual(['id', 'installed', 'name']);
    }
  });

  it('read_claude_access: the source is named, the token in the credentials file never leaves', async () => {
    const out = await h.call('read_claude_access', {});
    expect(out.outcome, out.message).toBe('done');
    expect(out.result).toMatchObject({ source: 'file', savedInPanel: false });
    expect(JSON.stringify(out)).not.toContain(TOKEN_IN_FILE);
    expect(JSON.stringify(out)).not.toContain('CREDFILE');
  });

  it('browse_folders: roots, subfolders without hidden ones; a relative path is refused', async () => {
    const roots = await h.call('browse_folders', {});
    expect(roots.outcome, roots.message).toBe('done');
    const rootList = roots.result as { folders: Array<{ path: string }> };
    expect(rootList.folders.map((folder) => folder.path)).toContain(home);

    const work = await h.call('browse_folders', { path: join(home, 'work') });
    expect(work.outcome, work.message).toBe('done');
    const listing = work.result as { path: string; folders: Array<{ name: string }> };
    expect(listing.folders.map((folder) => folder.name)).toEqual(['shop']);

    const relative = await h.call('browse_folders', { path: 'work' });
    expect(relative.outcome).toBe('failed');
  });

  it('list_providers / read_provider_checks / run_provider_check: check runs only by approval, without a model call by default', async () => {
    const providers = await h.call('list_providers', {});
    expect(providers.outcome, providers.message).toBe('done');
    expect(providers.result).toMatchObject({ active: 'claude' });
    expect(
      (providers.result as { providers: Array<{ id: string; status: string }> }).providers,
    ).toContainEqual(expect.objectContaining({ id: 'claude', status: 'verified' }));

    const empty = await h.call('read_provider_checks', {});
    expect(empty.result).toEqual({ checks: [] });

    const rejected = await h.decided('run_provider_check', {}, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(checkBodies).toEqual([]);
    expect((await h.call('read_provider_checks', {})).result).toEqual({ checks: [] });

    const settingsBefore = readFileSync(join(claudeDir, 'settings.json'), 'utf8');
    const { card, result } = await h.decided('run_provider_check', {});
    expect(
      card.preview.fields.find((field) => field.labelCode === 'label-provider-check-model-call')
        ?.valueCode,
    ).toBe('value-provider-check-model-call-off');
    expect(result.outcome, result.message).toBe('done');
    expect(checkBodies).toEqual([{ assistant: false }]);
    const check = result.result as {
      provider: string;
      steps: Array<{ id: string; status: string }>;
    };
    expect(check.provider).toBe('claude');
    expect(check.steps.find((step) => step.id === 'assistant')?.status).toBe('skipped');
    // Круг записи идёт на копии: файл человека тот же байт в байт.
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe(settingsBefore);

    const saved = await h.call('read_provider_checks', {});
    expect(saved.result).toMatchObject({ checks: [{ provider: 'claude' }] });
  });

  it('jira_transitions: transitions of the issue, only GET reaches Jira; unknown issue is a failure', async () => {
    const connected = await h.app.inject({
      method: 'PUT',
      url: '/api/integrations/atlassian',
      headers: { origin: HARNESS_ORIGIN },
      payload: {
        settings: {
          enabled: true,
          baseUrl: jira.url,
          email: '',
          deployment: 'server',
          confluenceUrl: '',
        },
        token: ATLASSIAN_TOKEN,
      },
    });
    expect(connected.statusCode).toBe(200);

    const out = await h.call('jira_transitions', { key: 'PRJ-7' });
    expect(out.outcome, out.message).toBe('done');
    expect(out.result).toMatchObject({
      transitions: [
        { id: '21', name: 'В работу' },
        { id: '31', name: 'Готово' },
      ],
    });
    expect(JSON.stringify(out)).not.toContain(ATLASSIAN_TOKEN);

    const missing = await h.call('jira_transitions', { key: 'PRJ-404' });
    expect(missing.outcome).toBe('failed');
    expect(jira.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('portability_fidelity: report for another CLI, nothing written to its folder; hook command key never shown; unknown target refused', async () => {
    // Id записи хука в каноне переноса несёт команду: ключ из неё не должен дойти до модели.
    const hookKey = `k${'Hq7Zt2Lw'.repeat(4)}`;
    writeFileSync(
      join(claudeDir, 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: `node notify.js --token ${hookKey}` }],
            },
          ],
        },
      }),
    );
    const out = await h.call('portability_fidelity', { target: 'gemini' });
    expect(out.outcome, out.message).toBe('done');
    const report = out.result as {
      target: string;
      summary: Record<string, number>;
      rows: Array<{ item: string; kind: string; level: string }>;
    };
    expect(report.target).toBe('gemini');
    expect(report.rows.length).toBeGreaterThan(0);
    expect(Object.keys(report.summary)).toContain('native');
    expect(existsSync(join(home, '.gemini'))).toBe(false);
    const hookItems = report.rows.filter((row) => row.item.startsWith('hook:'));
    expect(hookItems.length).toBeGreaterThan(0);
    expect(hookItems.every((row) => /^hook:PreToolUse#[0-9a-f]{8}$/.test(row.item))).toBe(true);
    // Фраза записи называет команду, но ключ в ней — маской.
    expect(JSON.stringify(out)).not.toContain(hookKey);

    const unknown = await h.call('portability_fidelity', { target: 'no-such-cli' });
    expect(unknown.outcome).toBe('failed');
  });

  it('summarize_resource: card before the model call, cached after; unknown resource and foreign project refused', async () => {
    const rejected = await h.decided(
      'summarize_resource',
      { type: 'skill', id: 'ladder' },
      'reject',
    );
    expect(rejected.result.outcome).toBe('rejected');
    expect(modelCalls).toEqual([]);

    const { card, result } = await h.decided('summarize_resource', { type: 'skill', id: 'ladder' });
    expect(card.preview.summaryCode).toBe('summary-summarize-resource');
    expect(result.outcome, result.message).toBe('done');
    expect(result.result).toEqual({ ru: 'Строит лестницу', en: 'Builds a ladder' });
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toContain('Делает лестницу');

    const cached = await h.decided('summarize_resource', { type: 'skill', id: 'ladder' });
    expect(cached.result.outcome).toBe('done');
    expect(modelCalls).toHaveLength(1);

    const missing = await h.decided('summarize_resource', { type: 'skill', id: 'nope' });
    expect(missing.result.outcome).toBe('failed');

    const foreign = await h.call('summarize_resource', {
      type: 'rule',
      id: 'x',
      project: join(home, 'elsewhere'),
    });
    expect(foreign.outcome).toBe('failed');
    expect(foreign.message).toContain('not registered');
    expect(modelCalls).toHaveLength(1);
  });
});
