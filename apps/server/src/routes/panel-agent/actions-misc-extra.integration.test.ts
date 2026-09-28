import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { PanelRunView } from '../../domains/analytics/session-process.ts';
import { registerAnalyticsRoutes } from '../analytics-routes.ts';
import { registerAnalyticsSessionRoutes } from '../analytics-session-routes.ts';
import { registerBackupRoutes } from '../backup-routes.ts';
import { registerPluginRoutes } from '../plugin-routes.ts';
import { manageHarness, type ManageHarness } from './manage-test-harness.ts';

/**
 * Аналитика (идущие агенты, где идёт сессия, стоп), удаление копии и каркас
 * плагина — настоящими маршрутами. Сессия «вне панели» — СВОЙ процесс node,
 * запущенный скриптом `claude.js` с `--session-id <новый uuid>`: его опознаёт
 * тот же список процессов CLI, что и настоящий терминал, и снимает тот же
 * `killPidTree`. Номер сессии свежий — чужой процесс под него не попадёт.
 */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('panel-agent actions: misc extra', () => {
  let root: string;
  let appData: string;
  let store: AppStore;
  let panelRuns: PanelRunView[];
  let fake: ChildProcess | undefined;
  let h: ManageHarness;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-misc-x-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    panelRuns = [];
    const ctx = {
      store,
      backupDir: store.backupDir,
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: join(root, 'skills'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
        },
      },
      applyIoSettings: () => {},
    } as unknown as ServerContext;
    h = await manageHarness(ctx, (app) => {
      registerAnalyticsRoutes(app, ctx);
      registerAnalyticsSessionRoutes(app, ctx, { active: () => panelRuns });
      registerBackupRoutes(app, ctx);
      registerPluginRoutes(app, ctx);
    });
  });

  afterEach(async () => {
    await h.close();
    if (fake?.pid && alive(fake.pid)) fake.kill();
    fake = undefined;
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** CLI «в терминале»: живёт, пока его не снимут. */
  async function startFakeCli(sessionId: string): Promise<number> {
    const dir = join(root, 'bin');
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'claude.js');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    fake = spawn(process.execPath, [script, '--session-id', sessionId], { stdio: 'ignore' });
    await new Promise<void>((done, fail) => {
      fake!.once('spawn', () => done());
      fake!.once('error', fail);
    });
    return fake.pid!;
  }

  /** Список процессов CLI снимается снимком ОС: ждём, пока в нём появится наш. */
  async function whereOf(sessionId: string): Promise<{ where: { kind: string; pid?: number } }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const out = await h.call('session_where', { sessionId });
      const result = out.result as { where: { kind: string; pid?: number } };
      if (result.where.kind === 'process') return result;
      await new Promise((done) => setTimeout(done, 300));
    }
    throw new Error('the fake CLI never showed up in the process list');
  }

  it('идущие агенты: число и список согласованы, командной строки в ответе нет', async () => {
    const out = await h.call('analytics_live', {});
    expect(out.outcome).toBe('done');
    const live = out.result as { at: string; count: number; agents: object[] };
    expect(live.count).toBeGreaterThanOrEqual(live.agents.length);
    expect(Number.isNaN(Date.parse(live.at))).toBe(false);
    for (const agent of live.agents) expect(Object.keys(agent)).not.toContain('commandLine');
  });

  it('где идёт: чат панели, закончилась, пишется без процесса; кривой номер — отказ схемы', async () => {
    const chatSession = randomUUID();
    panelRuns = [{ chatId: 'chat-1', sessionId: chatSession, status: 'running' }];
    const panel = await h.call('session_where', { sessionId: chatSession });
    expect(panel.result).toMatchObject({ where: { kind: 'panel', chatId: 'chat-1' } });

    const finished = await h.call('session_where', { sessionId: randomUUID() });
    expect(finished.result).toMatchObject({ where: { kind: 'finished' } });

    const writing = randomUUID();
    mkdirSync(join(root, 'projects', 'shop'), { recursive: true });
    writeFileSync(join(root, 'projects', 'shop', `${writing}.jsonl`), '{}\n');
    const unidentified = await h.call('session_where', { sessionId: writing });
    expect(unidentified.result).toMatchObject({ where: { kind: 'unidentified' } });

    expect((await h.call('session_where', { sessionId: 'not-a-session' })).outcome).toBe('invalid');
  });

  it('стоп: чат панели, закончившаяся и неопознанная — отказ до карточки', async () => {
    const chatSession = randomUUID();
    panelRuns = [{ chatId: 'chat-1', sessionId: chatSession, status: 'running' }];
    const panel = await h.call('stop_session', { sessionId: chatSession });
    expect(panel.outcome).toBe('failed');
    expect(panel.message).toContain('chat of the panel');

    const done = await h.call('stop_session', { sessionId: randomUUID() });
    expect(done.outcome).toBe('failed');
    expect(done.message).toContain('Nothing to stop');

    const writing = randomUUID();
    mkdirSync(join(root, 'projects', 'shop'), { recursive: true });
    writeFileSync(join(root, 'projects', 'shop', `${writing}.jsonl`), '{}\n');
    const unknown = await h.call('stop_session', { sessionId: writing });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toContain('only the human');
    expect(await h.pendingCards()).toEqual([]);
  });

  it('стоп CLI вне панели: отказ человека — процесс жив; одобрение — процесс снят', async () => {
    const sessionId = randomUUID();
    const pid = await startFakeCli(sessionId);
    const where = await whereOf(sessionId);
    expect(where.where).toMatchObject({ kind: 'process', pid, ownsPanel: false });

    const rejected = await h.decided('stop_session', { sessionId }, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(alive(pid)).toBe(true);

    const { card, result } = await h.decided('stop_session', { sessionId });
    expect(card.risk).toBe('danger');
    expect(card.preview.fields[0]?.value).toContain(String(pid));
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ result: 'stopped', pid });
    expect(alive(pid)).toBe(false);

    const again = await h.call('stop_session', { sessionId });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('Nothing to stop');
  }, 60_000);

  it('копия: удаление карточкой danger; отказ человека — файл на месте; незнакомое имя — отказ', async () => {
    const name = 'settings.json.2026-01-01T00-00-00-000Z.bak';
    mkdirSync(store.backupDir, { recursive: true });
    const path = join(store.backupDir, name);
    writeFileSync(path, '{"model":"old"}\n');

    const rejected = await h.decided('delete_backup', { name }, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    expect(existsSync(path)).toBe(true);

    const { card, result } = await h.decided('delete_backup', { name });
    expect(card.risk).toBe('danger');
    expect(card.preview.fields.map((field) => field.value)).toContain('settings.json');
    expect(result.outcome).toBe('done');
    expect(existsSync(path)).toBe(false);

    const missing = await h.call('delete_backup', { name });
    expect(missing.outcome).toBe('failed');
    expect(missing.message).toContain('No backup');
    expect(await h.pendingCards()).toEqual([]);
  });

  it('каркас плагина: только выбранные части; занятая папка и относительный путь — отказ до карточки', async () => {
    const dir = join(root, 'plugins');
    mkdirSync(dir);
    const input = { dir, name: 'qa-kit', commands: true, skills: true };

    const { card, result } = await h.decided('scaffold_plugin', input);
    expect(card.preview.summaryCode).toBe('summary-scaffold-plugin');
    expect(card.preview.fields.map((field) => field.value)).toContain('commands, skills');
    expect(result.outcome).toBe('done');
    const target = join(dir, 'qa-kit');
    expect(existsSync(join(target, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(target, 'commands'))).toBe(true);
    expect(existsSync(join(target, 'skills'))).toBe(true);
    expect(existsSync(join(target, 'agents'))).toBe(false);
    expect(existsSync(join(target, 'hooks'))).toBe(false);

    const again = await h.call('scaffold_plugin', input);
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('already exists');
    const relative = await h.call('scaffold_plugin', { ...input, dir: 'plugins' });
    expect(relative.outcome).toBe('failed');
    expect(await h.pendingCards()).toEqual([]);
  });
});
