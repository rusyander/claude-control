import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { readRunInputs } from '../../domains/chat/run-input/run-input.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * «Что получил агент» (U8) на настоящей сборке: \`createRuntime\` сам связывает
 * реестр прогонов с хранилищем в каталоге данных. Подменён только процесс CLI.
 * Проверяется проводка, которой юнит-тесты не видят: вход первого хода нового
 * разговора доезжает до настоящего \`sessionId\`. Ход чужого CLI ведёт ядро —
 * его вход пишет журнал задачи, а не этот каталог.
 */
describe('runtime: «что получил агент» пишется в каталог данных', () => {
  let root: string;
  let appData: string;
  let runtime: Runtime;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-input-')));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    const ctx = {
      store: new AppStore(appData),
      location: {
        paths: {
          root,
          appData,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    runtime = createRuntime(ctx, 'http://127.0.0.1:1');
  });

  afterEach(() => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('новый разговор Claude: вход первого хода — под настоящим sessionId', async () => {
    const fake = (): RunLike => ({
      start: async (_options, onEvent) => {
        onEvent({ kind: 'session', sessionId: 'sess-real', model: 'opus', tools: 1 });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-real' });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;

    runtime.chatRuns.start('new-1', { prompt: 'Задание звена', cwd: root }, {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readRunInputs(appData, 'sess-real').map((run) => run.prompt)).toEqual(['Задание звена']);
    expect(readRunInputs(appData, 'new-1')).toEqual([]);
  });
});
