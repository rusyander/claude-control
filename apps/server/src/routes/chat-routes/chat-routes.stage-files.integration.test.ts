import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { createHandoffPlanner } from '../chat/handoff-routes.ts';
import { registerChatRunRoutes } from '../chat/run-routes/run-routes.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { HandoffChains } from '../../domains/chat/ChatHandoff/ChatHandoff.ts';
import { sandboxRoot } from '../../domains/chat/ChatArtifacts/ChatArtifacts.ts';
import { groupPlanPath } from '../../domains/chat/ChatCascadeStages/stage-files.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';

/**
 * План группы файлом (L2.1) и артефакты прошлых звеньев (L7.4) — по настоящему
 * пути: маршрут отправки сообщения → реестр → планировщик звеньев → файлы в
 * настоящей копии-worktree. Подменён только процесс CLI: он записывает задание,
 * с которым панель завела звено ревью, — это и есть доказательство.
 */

const CHAT = 'чат-работа-план-файлом';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function put(dir: string, path: string, body = 'x', at?: Date): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
  if (at) utimesSync(join(dir, path), at, at);
}

const filler = (label: string, chars: number): string =>
  Array.from(
    { length: Math.ceil(chars / 60) },
    (_, i) => `- ${label} ${i}: src/${label}-${i}.ts — правка обработчика`,
  ).join('\n');

// Начало плана (§1–§4) — больше порога разреза; метки разделов ищутся в задании.
const PLAN = [
  '## 1. Анализ кода',
  'МЕТКА-АНАЛИЗА',
  filler('analysis', 1500),
  '## 4. Шаги',
  'МЕТКА-ШАГОВ',
  filler('step', 1500),
  '## 5. Критерии приёмки',
  'МЕТКА-КРИТЕРИЕВ',
  '## 6. Уровень проверки',
  '- живой прогон',
].join('\n');

const WORK_LINK: ChatLink = {
  parentChatId: 'родитель',
  createdAt: '2026-09-25T10:00:00.000Z',
  title: 'Загрузка',
  branch: 'split/upload',
  groupIndex: 0,
  model: 'sonnet',
  effort: 'medium',
  kind: 'implementation',
  lowered: true,
  stage: 'work',
  ceilingModel: 'claude-opus-5',
  ceilingEffort: 'high',
  groupTask: 'Почини загрузку файлов',
  planSummary: PLAN,
};

describe('звено после работы получает план файлом и артефакты путями (L2.1, L7.4)', () => {
  let root: string;
  let main: string;
  let copy: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let prompts: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-stage-files-'));
    main = join(root, 'main');
    copy = join(root, 'copy');
    mkdirSync(main, { recursive: true });
    git(main, 'init', '-q');
    put(main, 'a.txt', 'a');
    git(main, 'add', '.');
    git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'split/upload', copy);
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    prompts = [];
    registry = new ChatRunRegistry((): RunLike => ({
      start: async (options, onEvent) => {
        prompts.push(options.prompt);
        onEvent({ kind: 'text', text: 'Готово.' });
        onEvent({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 's' });
      },
      stop: () => undefined,
    }));
    registry.setHandoffPlanner(
      createHandoffPlanner({
        runs: registry,
        chains: new HandoffChains(),
        session: new ChatSession(registry),
        selfBaseUrl: 'http://127.0.0.1:5178',
        cascade: {
          linkOf: (aliases) => aliases.map((key) => store.getChatLink(key)).find(Boolean),
          saveLink: (chatId, link) => store.setChatLink(chatId, link),
          markReviewed: () => undefined,
          hasWork: () => true,
          settings: () => ({ taskSplitInitiative: true, handoffInitiative: false }),
        },
      }),
    );
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          appData: join(root, 'agentdeck'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, new ChatSession(registry));
    await app.ready();
    store.setChatLink(CHAT, WORK_LINK);
  });

  afterEach(async () => {
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join(sandboxRoot(), CHAT), { recursive: true, force: true });
  });

  /** Ход работы кончился — вернуть задание звена ревью, которое он завёл. */
  async function reviewPrompt(projectPath = copy): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId: CHAT, prompt: 'Сделай', projectPath },
    });
    expect(response.statusCode).toBe(200);
    await new Promise((done) => setTimeout(done, 50));
    const review = Object.values(store.getChatLinks()).find((link) => link.stage === 'review');
    expect(review).toBeDefined();
    expect(prompts).toHaveLength(2);
    return prompts[1]!;
  }

  it('план — файлом по игнорируемому пути, не в git status; в задании §5+ и путь', async () => {
    // Слой `.agent/` проекта игнорируется — exclude общий для всех worktree.
    put(main, '.git/info/exclude', '.agent/\n');
    // Перенесено из основного каталога (старое время) и сделано работой.
    put(copy, '.agent/tickets/OLD-1.agent.md', 'old', new Date('2026-01-01T00:00:00Z'));
    put(copy, '.agent/tmp/gates-work.log', 'green');

    const prompt = await reviewPrompt();
    const rel = groupPlanPath(PLAN);
    expect(prompt).toContain(rel);
    expect(prompt).toContain('МЕТКА-КРИТЕРИЕВ');
    expect(prompt).not.toContain('МЕТКА-АНАЛИЗА');
    expect(prompt).not.toContain('МЕТКА-ШАГОВ');
    expect(readFileSync(join(copy, rel), 'utf8')).toBe(`${PLAN}\n`);
    expect(git(copy, 'status', '--porcelain')).toBe('');
    // Артефакты — только сделанное в копии.
    expect(prompt).toContain('.agent/tmp/gates-work.log');
    expect(prompt).not.toContain('OLD-1.agent.md');
  });

  it('путь не игнорируется — файла нет, план едет целиком', async () => {
    const prompt = await reviewPrompt();
    expect(prompt).not.toContain(groupPlanPath(PLAN));
    expect(prompt).toContain('МЕТКА-АНАЛИЗА');
    expect(prompt).toContain('МЕТКА-ШАГОВ');
    expect(prompt).toContain('МЕТКА-КРИТЕРИЕВ');
    expect(existsSync(join(copy, '.agent', 'plans'))).toBe(false);
  });

  it('общий каталог без копии: артефакты — новее связи работы, старое человека — нет', async () => {
    // Связь работы заведена 2026-09-25: файл раньше неё — не работа группы.
    put(main, '.agent/tickets/OLD-1.agent.md', 'old', new Date('2026-01-01T00:00:00Z'));
    put(main, '.agent/tmp/gates-work.log', 'green');

    const prompt = await reviewPrompt(main);
    expect(prompt).toContain('.agent/tmp/gates-work.log');
    expect(prompt).not.toContain('OLD-1.agent.md');
  });
});
