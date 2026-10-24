import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import type { ChatEvent } from '../../../domains/chat/chat-events.ts';
import { deferredIdOf, isPanelRefusal } from '@agentdeck/contracts/deferred-asks';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Маршрут прав группы: каталог оболочки CLI из транскрипта (N4) и погашение
 * процессов по своему дереву (N3) — журнал 23.10. Настоящие маршрут, хранилище,
 * копия git, транскрипт на диске и дерево процессов ОС; заглушен только сам
 * CLI — вместо него живой процесс node с ребёнком, его номер — номер прогона.
 */
describe('маршрут прав группы: каталог оболочки и погашение процессов', () => {
  let root: string;
  let project: string;
  let copy: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let events: ChatEvent[];
  const detaches: (() => void)[] = [];
  const GROUP = 'group-chat';

  /** «CLI» группы и его ребёнок (dev-сервер группы); чужой процесс — рядом, не под ним. */
  let cli: ChildProcess;
  let childPid = 0;
  let stranger: ChildProcess;

  const SLEEP = 'setInterval(() => undefined, 1000)';

  beforeAll(async () => {
    cli = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(SLEEP)}], { stdio: 'ignore' }); console.log(c.pid); ${SLEEP}`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    childPid = await new Promise<number>((done) => {
      cli.stdout?.once('data', (chunk: Buffer) => done(Number(String(chunk).trim())));
    });
    stranger = spawn(process.execPath, ['-e', SLEEP], { stdio: 'ignore' });
  });

  afterAll(() => {
    for (const pid of [childPid, cli.pid, stranger.pid]) {
      try {
        if (pid) process.kill(pid);
      } catch {
        // уже вышел
      }
    }
  });

  const liveRun = (): RunLike => ({
    start: () => new Promise(() => undefined),
    stop: () => undefined,
    pid: cli.pid,
  });

  /** Транскрипт разговора группы: CLI пишет `cwd` в каждую запись. */
  const transcript = (): string => join(root, 'projects', 'copy-dir', `${GROUP}.jsonl`);
  const recordCall = (toolUseId: string, cwd: string): void => {
    const line = {
      type: 'assistant',
      cwd,
      sessionId: GROUP,
      message: {
        id: `msg-${toolUseId}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: {} }],
      },
    };
    writeFileSync(transcript(), `${JSON.stringify(line)}\n`, { flag: 'a' });
  };

  /**
   * Ответ маршрута или `'card'` — вызов придержан карточкой человеку. Группу никто
   * не смотрит: вызов человеку — `'deferred'` (D-n), известный ответ — `'refused'`.
   */
  const ask = async (command: string, toolUseId: string): Promise<string> => {
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: GROUP, toolName: 'Bash', input: { command }, toolUseId },
    });
    const hasCard = (): boolean =>
      events.some(
        (event) =>
          event.kind === 'permission' && (event as { toolUseId?: string }).toolUseId === toolUseId,
      );
    let settled = 'pending';
    void pending.then((res) => {
      const body = res.json<{ behavior: string; message?: string }>();
      const message = body.message ?? '';
      settled =
        body.behavior === 'deny' && deferredIdOf(message)
          ? 'deferred'
          : body.behavior === 'deny' && isPanelRefusal(message)
            ? 'refused'
            : body.behavior;
    });
    const deadline = Date.now() + 15_000;
    while (settled === 'pending' && !hasCard() && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    if (settled !== 'pending') return settled;
    const card = hasCard();
    session.abort(GROUP);
    await pending;
    return card ? 'card' : 'pending-without-card';
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-cwd-kill-'));
    project = join(root, 'repo');
    copy = join(root, 'repo-group');
    mkdirSync(project, { recursive: true });
    const git = (cwd: string, args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
    };
    git(project, ['init', '-q']);
    git(project, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(project, ['worktree', 'add', '-q', '-b', 'feature/a', copy]);
    // Отслеживаемое рядом с подпроектом: его удаление git вернёт.
    mkdirSync(join(copy, 'docs', 'old'), { recursive: true });
    mkdirSync(join(copy, 'inst-docs-ui'), { recursive: true });
    writeFileSync(join(copy, 'docs', 'old', 'a.md'), 'a\n');
    writeFileSync(join(copy, 'inst-docs-ui', 'package.json'), '{}\n');
    git(copy, ['add', '-A']);
    git(copy, ['commit', '-q', '-m', 'docs']);
    mkdirSync(join(root, 'projects', 'copy-dir'), { recursive: true });
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent',
      projectPath: project,
      createdAt: new Date().toISOString(),
      order: [0],
      request: { allowEdits: true },
      proposal: { groups: [] },
      groups: [{ index: 0, branch: 'feature/a', status: 'running', chatId: GROUP }],
    } as unknown as SplitPlanRecord);
    store.setChatLink(GROUP, {
      parentChatId: 'parent',
      groupIndex: 0,
      branch: 'feature/a',
      createdAt: new Date().toISOString(),
    });
    events = [];
    registry = new ChatRunRegistry(liveRun);
    session = new ChatSession(registry);
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          appData: join(root, 'agentdeck'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    await app.ready();
    registry.start(GROUP, { prompt: 'задача группы', cwd: copy }, { projectPath: copy });
    detaches.push(
      registry.attach(GROUP, 0, {
        send: ({ event }) => void events.push(event),
        close: () => undefined,
      }) as () => void,
    );
  });

  afterEach(async () => {
    for (const detach of detaches.splice(0)) detach();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('N4: `..` из подпроекта по записи транскрипта — своя копия, сама', async () => {
    recordCall('toolu_n4_sub', join(copy, 'inst-docs-ui'));
    const command =
      'node -e "require(\'fs\').existsSync(\'package.json\')" && ls node_modules | wc -l && rm -rf ../docs/old; echo "rm $?"';
    expect(await ask(command, 'toolu_n4_sub')).toBe('allow');
    // Тот же вызов без записи в транскрипте — от корня копии, `../docs` вне неё.
    expect(await ask(command, 'toolu_n4_none')).toBe('deferred');
  });

  it('N4: каталог в транскрипте вне копии мягче не делает', async () => {
    recordCall('toolu_n4_out', join(root, 'repo', 'inst-docs-ui'));
    expect(await ask('rm -rf ../docs/old', 'toolu_n4_out')).toBe('deferred');
  });

  // F-77 (решение владельца 23.10): вне копии своё — только рабочая папка CLI этой
  // сессии. Её путь маршрут берёт из папки транскрипта (имя проекта) и номера сессии.
  it('F-77: уборка в своей рабочей папке CLI — сама, в папке другой сессии — карточка', async () => {
    recordCall('toolu_f77_seed', copy);
    const scratch = join(tmpdir(), 'claude', 'copy-dir', GROUP, 'scratchpad').replace(/\\/g, '/');
    expect(await ask(`rm -rf "${scratch}/probe"`, 'toolu_f77_own')).toBe('allow');
    const other = scratch.replace(`/${GROUP}/`, '/9d0c6f7e-1b2a-4c3d-8e9f-0a1b2c3d4e5f/');
    expect(await ask(`rm -rf "${other}/probe"`, 'toolu_f77_other')).toBe('deferred');
  });

  it('N3: ребёнок своего CLI гасится сам, чужой процесс — карточка', async () => {
    expect(await ask(`taskkill //PID ${childPid} //F`, 'toolu_n3_own')).toBe('allow');
    expect(await ask(`kill -9 ${childPid}`, 'toolu_n3_own_kill')).toBe('allow');
    expect(await ask(`taskkill //PID ${stranger.pid} //F`, 'toolu_n3_foreign')).toBe('deferred');
    expect(
      await ask(`taskkill //PID ${childPid} //PID ${stranger.pid} //F`, 'toolu_n3_mixed'),
    ).toBe('deferred');
    // Цель не назвать — человеку.
    expect(await ask('lsof -ti:5173 | xargs kill -9', 'toolu_n3_pipe')).toBe('deferred');
  });
});
