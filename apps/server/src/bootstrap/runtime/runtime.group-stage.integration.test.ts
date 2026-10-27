import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunLike } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { registerChatRoutes } from '../../routes/chat-routes/chat-routes.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { CLI_HELP_AGENT_DENY } from '../../domains/chat/group-profile/group-profile.ts';
import { SPLIT_MCP_TAG } from '@agentdeck/contracts/split-tickets';
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
  /** Ответы прогонов по порядку; кончились — «Готово.». */
  let answers: string[];

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
    answers = [];
    const fake = (): RunLike => ({
      start: async (options, onEvent) => {
        started.push(options);
        onEvent({ kind: 'text', text: answers.shift() ?? 'Готово.' });
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
    await removeWhenFree(root);
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

  // Слияние MR закрыто в каждом звене (F-13); подагенты справки CLI не нужны ни одному (контекст g2 F9).
  const MERGE_ONLY = [
    'mcp__gitlab-work__merge_merge_request',
    'mcp__gitlab-work__merge_pull_request',
    'mcp__gitlab-work__approve_merge_request',
    ...CLI_HELP_AGENT_DENY,
  ];

  it('доставка: запись на месте, описание — у навыка доставки, ревью — имя', async () => {
    const settings = await settingsOf('deliver');
    // Под запретом только слияние MR и подагенты справки CLI.
    expect(settings.permissions?.deny).toEqual(MERGE_ONLY);
    expect(settings.skillOverrides?.['deep-review']).toBe('name-only');
    expect(settings.skillOverrides?.['prepare-mr']).toBeUndefined();
  });

  it('работа (связь без звена): весь набор группы, запрета записи нет', async () => {
    const settings = await settingsOf(undefined);
    expect(settings.permissions?.deny).toEqual(MERGE_ONLY);
    expect(settings.skillOverrides?.['deep-review']).toBeUndefined();
    expect(settings.skillOverrides?.['prepare-mr']).toBeUndefined();
  });

  /**
   * N8 (g8 26.10): правки и проверка правок шли со всеми серверами проекта — 196
   * имён MCP в каждом ходе при нуле вызовов. Набор — по виду звена связи; проход
   * проверки — звено ревью со списком правок.
   */
  describe('набор MCP — по виду звена связи (N8)', () => {
    async function mcpOf(patch: Partial<ChatLink>): Promise<string[] | undefined> {
      store.setChatLink(CHILD, { ...LINK, ...patch });
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/send',
        payload: { chatId: CHILD, prompt: 'Продолжай', projectPath: project },
      });
      expect(response.statusCode).toBe(200);
      await new Promise((done) => setTimeout(done, 50));
      const run = started.find((item) => item.permissionPrompt?.runId === CHILD);
      expect(run?.platformArgs ?? []).toContain('--strict-mcp-config');
      return run?.platformMcp?.ids;
    }

    it('правки и проверка правок — без серверов; ревью и доставка — с хранилищем кода', async () => {
      expect(await mcpOf({ stage: 'fix', fixFindings: ['🟡 F-1'] })).toEqual([]);
      started.length = 0;
      expect(await mcpOf({ stage: 'review', fixFindings: ['🟡 F-1'] })).toEqual([]);
      started.length = 0;
      expect(await mcpOf({ stage: 'review' })).toEqual(['gitlab-work']);
      started.length = 0;
      expect(await mcpOf({ stage: 'deliver' })).toEqual(['gitlab-work']);
    });

    it('правки попросили сервер блоком mcp — та же сессия продолжает с ним, проверка — после', async () => {
      store.setSplitPlan({
        ...SPLIT,
        projectPath: project,
        groups: [{ ...SPLIT.groups[0]!, chatId: CHILD, path: project }],
      });
      answers = [
        `Нужен MR.\n<${SPLIT_MCP_TAG}>\nserver: gitlab-work\nwhy: обсуждение MR\n</${SPLIT_MCP_TAG}>`,
      ];
      store.setChatLink(CHILD, {
        ...LINK,
        stage: 'fix',
        fixFindings: ['🟡 F-1 src/a.ts:3 — подпись'],
        lowered: true,
        model: 'sonnet',
        ceilingModel: 'opus',
        task: 'PROJ-1',
        groupTask: 'PROJ-1',
      });
      // Ответ маршрута — поток хода этого чата, и продолжение в нём держит поток
      // открытым: старты прогонов читаются, ответ маршрута не ждётся.
      void app.inject({
        method: 'POST',
        url: '/api/chat/send',
        payload: { chatId: CHILD, prompt: 'Правки', projectPath: project },
      });
      for (let i = 0; i < 40 && started.length < 3; i += 1) {
        await new Promise((done) => setTimeout(done, 50));
      }
      const prompts = started.map((run) => run.prompt);
      // Ход правок без серверов → продолжение той же сессии с сервером → проверка.
      expect(started[0]?.platformMcp?.ids).toEqual([]);
      expect(prompts[1]).toContain(
        'The panel connected the MCP server(s) you asked for: gitlab-work',
      );
      expect(started[1]?.platformMcp?.ids).toEqual(['gitlab-work']);
      expect(prompts[2]).toContain('VERIFYING those fixes');
    });
  });

  /**
   * F-04 ревью П1: цепочка кончилась, доставку взял конвейер (группа ждёт
   * доставки по фактам git) — звена доставки впереди уже не будет, и ход в чат
   * группы (напоминание «отправь ветку, открой MR», ответ человека) идёт С
   * правом пуша. Раньше запрет «следующих звеньев» висел и здесь: просьба
   * пушить уходила в сессию, которой пуш запрещён, напоминания сгорали.
   */
  describe('доставка впереди — только пока её заведёт конвейер (F-04)', () => {
    const delivering = (group: Partial<SplitPlanRecord['groups'][number]>): void => {
      store.setSplitPlan({
        ...SPLIT,
        projectPath: project,
        groups: [{ ...SPLIT.groups[0]!, deliver: true, ...group }],
      });
    };

    it('группа работает — пуш и MR этой сессии запрещены: их сделает звено доставки', async () => {
      delivering({ status: 'started' });
      const settings = await settingsOf('work');
      expect(settings.permissions?.deny).toEqual(
        expect.arrayContaining(['Bash(git push*)', 'mcp__gitlab-work__create_merge_request']),
      );
    });

    it('группа ждёт доставки — ход напоминания пушит: запрета пуша и MR нет', async () => {
      delivering({ status: 'awaiting', waitingFor: 'delivery' });
      const settings = await settingsOf('work');
      const deny = settings.permissions?.deny ?? [];
      expect(deny).not.toContain('Bash(git push*)');
      expect(deny).not.toContain('Bash(gh pr create*)');
      expect(deny).not.toContain('mcp__gitlab-work__create_merge_request');
    });
  });
});
