import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerContext } from './context.ts';

/**
 * Перенос настроек на другую машину через git: снимок рядом со `state.json`,
 * при старте панель применяет снимок, которого сама не писала. Проверяется
 * настоящий старт (`ServerContext`), а не функция слияния: до правки
 * конструктор хранилища успевал переписать принесённый снимок своим, и перенос
 * не срабатывал ни разу.
 */
describe('settings snapshot at startup', () => {
  let root: string;
  let appData: string;
  const previousEnv = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-snapshot-'));
    appData = join(root, 'agentdeck');
    process.env.CLAUDE_CONFIG_DIR = root;
  });

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const snapshotFile = (): string => join(appData, 'settings-snapshot.json');
  const readSnapshot = (): { version: number; state: Record<string, unknown> } =>
    JSON.parse(readFileSync(snapshotFile(), 'utf8')) as {
      version: number;
      state: Record<string, unknown>;
    };

  /** Снимок «с другой машины»: файл, которого эта панель не писала. */
  function pull(state: Record<string, unknown>): void {
    mkdirSync(appData, { recursive: true });
    writeFileSync(snapshotFile(), `${JSON.stringify({ version: 1, state }, null, 2)}\n`);
  }

  it('первый старт пишет снимок, правка настроек его обновляет', () => {
    const ctx = new ServerContext();
    expect(readSnapshot().version).toBe(1);
    ctx.store.updateSettings({ backupKeep: 9 });
    expect((readSnapshot().state.settings as Record<string, unknown>).backupKeep).toBe(9);
  });

  it('свежая машина применяет снимок, записанный другой, а здешнее остаётся своим', () => {
    const other = join(root, 'other-machine');
    mkdirSync(other, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = other;
    const source = new ServerContext();
    const projectPath = join(homedir(), 'work', 'app');
    source.store.addProject({ id: 'p', name: 'app', path: projectPath });
    source.store.updateSettings({
      backupKeep: 4,
      remoteAccess: { enabled: true, publicUrl: 'https://there.ts.net', notify: true },
    });
    const text = readFileSync(join(other, 'agentdeck', 'settings-snapshot.json'), 'utf8');
    expect(text).toContain('<HOME>');
    expect(text).not.toContain('there.ts.net');

    process.env.CLAUDE_CONFIG_DIR = root;
    mkdirSync(appData, { recursive: true });
    writeFileSync(snapshotFile(), text);
    const ctx = new ServerContext();
    expect(ctx.store.getSettings().backupKeep).toBe(4);
    expect(ctx.store.getSettings().remoteAccess.enabled).toBe(false);
    expect(ctx.store.getProjects()).toEqual([{ id: 'p', name: 'app', path: projectPath }]);
  });

  it('свой снимок на следующем старте не применяется повторно', () => {
    pull({ settings: { backupKeep: 4 } });
    const first = new ServerContext();
    first.store.updateSettings({ backupKeep: 6 });
    const second = new ServerContext();
    expect(second.store.getSettings().backupKeep).toBe(6);
  });

  it('снимок, обновлённый git между стартами, применяется при перезапуске', () => {
    const first = new ServerContext();
    first.store.updateSettings({ backupKeep: 6 });
    pull({ settings: { backupKeep: 2 } });
    const second = new ServerContext();
    expect(second.store.getSettings().backupKeep).toBe(2);
  });

  it('испорченный снимок не применяется, панель пишет свой', () => {
    const first = new ServerContext();
    first.store.updateSettings({ backupKeep: 6 });
    mkdirSync(appData, { recursive: true });
    writeFileSync(snapshotFile(), '<<<<<<< HEAD\n{"version":1}\n=======\n');
    const second = new ServerContext();
    expect(second.store.getSettings().backupKeep).toBe(6);
    expect((readSnapshot().state.settings as Record<string, unknown>).backupKeep).toBe(6);
  });

  it('снимок, не прошедший схему, не применяется', () => {
    const first = new ServerContext();
    first.store.updateSettings({ backupKeep: 6 });
    pull({ groups: 'not-an-array', settings: { backupKeep: 1 } });
    const second = new ServerContext();
    expect(second.store.getSettings().backupKeep).toBe(6);
  });
});
