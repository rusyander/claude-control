import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { registerChatRoutes } from '../../routes/chat-routes/chat-routes.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Профиль звена группы (L1.2, L1.3) поверх НАСТОЯЩЕЙ сборки: `createRuntime`, его
 * резолвер профиля группы, личные навыки и MCP-серверы из файлов, маршрут
 * отправки сообщения. Подменён только процесс CLI. Что настоящий CLI делает с
 * этими настройками, доказывает `tools/qa/check-run-layers.mjs` (случай 0); здесь —
 * что сборка отдаёт профилю звено той связи, которой идёт прогон.
 */

const PARENT = 'родитель-звенья';
const CHILD = 'чат-звена';

const SPLIT: SplitPlanRecord = {
  parentChatId: PARENT,
  projectPath: '',
  createdAt: '2026-10-19T00:00:00.000Z',
  order: [0],
  request: {},
  proposal: { groups: [{ title: 'Загрузка', tasks: ['PROJ-1'] }] },
  groups: [
    {
      index: 0,
      title: 'Загрузка',
      branch: 'feature/g1',
      after: [],
      status: 'started',
      chatId: 'child-1',
    },
  ],
} as unknown as SplitPlanRecord;

const LINK: ChatLink = {
  parentChatId: PARENT,
  createdAt: '2026-10-19T00:00:00.000Z',
  branch: 'feature/g1',
  groupIndex: 0,
};

interface StageSettings {
  skillOverrides?: Record<string, string>;
  permissions?: { ask?: string[]; deny?: string[] };
}

describe('звено группы получает свой профиль запуска (L1.2, L1.3)', () => {
  let root: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let app: FastifyInstance;
  let started: RunOptions[];

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-stage-')));
    const appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    // Личный сервер хранилища кода — его запись звену ревью снимается.
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({ mcpServers: { 'gitlab-work': { command: 'node', args: ['gitlab.mjs'] } } }),
      'utf8',
    );
    for (const name of ['deep-review', 'prepare-mr']) {
      mkdirSync(join(root, 'skills', name), { recursive: true });
      writeFileSync(
        join(root, 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${name}\n---\n`,
        'utf8',
      );
    }
    store = new AppStore(appData);
    store.setSplitPlan({ ...SPLIT, projectPath: project });
    const ctx = {
      store,
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
    started = [];
    const fake = (): RunLike => ({
      start: async (options, onEvent) => {
        started.push(options);
        onEvent({ kind: 'text', text: 'Готово.' });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess' });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;
    app = Fastify();
    registerChatRoutes(
      app,
      ctx,
      runtime.chatRuns,
      runtime.chatSession,
      (chatId) => runtime.treePause.awaitsHuman(chatId),
      (chatId) => runtime.statusChats.assignedOf(chatId),
    );
    await app.ready();
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Ход в чат звена — настройки, с которыми сборка его запустила. */
  async function settingsOf(stage: ChatLink['stage']): Promise<StageSettings> {
    store.setChatLink(CHILD, { ...LINK, ...(stage ? { stage } : {}) });
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHILD, prompt: 'Продолжай', projectPath: project },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 50));
    const run = started.find((item) => item.permissionPrompt?.runId === CHILD);
    expect(run?.platformArgs ?? []).toContain('--strict-mcp-config');
    return (run?.platformSettings ?? {}) as StageSettings;
  }

  it('ревью: запись в хранилище кода снята, описание — у навыка ревью, доставке — имя', async () => {
    const settings = await settingsOf('review');
    expect(settings.permissions?.deny).toEqual(
      expect.arrayContaining(['mcp__gitlab-work__create_*', 'mcp__gitlab-work__*_create_*']),
    );
    expect(settings.skillOverrides?.['prepare-mr']).toBe('name-only');
    expect(settings.skillOverrides?.['deep-review']).toBeUndefined();
  });

  it('доставка: запись на месте, описание — у навыка доставки, ревью — имя', async () => {
    const settings = await settingsOf('deliver');
    expect(settings.permissions?.deny).toBeUndefined();
    expect(settings.skillOverrides?.['deep-review']).toBe('name-only');
    expect(settings.skillOverrides?.['prepare-mr']).toBeUndefined();
  });

  it('работа (связь без звена): весь набор группы, запрета записи нет', async () => {
    const settings = await settingsOf(undefined);
    expect(settings.permissions?.deny).toBeUndefined();
    expect(settings.skillOverrides?.['deep-review']).toBeUndefined();
    expect(settings.skillOverrides?.['prepare-mr']).toBeUndefined();
  });
});
