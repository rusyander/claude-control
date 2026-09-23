import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { ChatRunRegistry, type RunLike } from '../../domains/chat/ChatRunRegistry.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner.ts';
import { ChatSession } from '../../domains/chat/ChatSession.ts';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import { branchGateContext } from '../../domains/chat/ChatBranchGate.ts';
import { registerChatRunRoutes } from './run-routes.ts';

/**
 * Ворота ветки поверх НАСТОЯЩИХ маршрутов и НАСТОЯЩЕГО git.
 *
 * Заглушен ровно один слой — процесс CLI: он и есть та внешняя граница, которой
 * у теста быть не может. Репозиторий, копия (`git worktree`), брокер прав,
 * реестр прогонов и разбор тела запроса — настоящие, потому что вопрос теста
 * именно в них: придержится ли первая правка, заведётся ли копия на диске и
 * поднимется ли прогон заново в НОВОМ каталоге.
 */
describe('маршруты чата: ворота ветки', () => {
  let root: string;
  let repo: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let started: { cwd: string; prompt: string; sessionId?: string }[];
  let events: ChatEvent[];
  let detach: (() => void) | undefined;
  const CHAT = 'branch-gate-chat';
  const SESSION = 'branch-gate-session';

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  /** Прогон, который НЕ заканчивается сам: иначе реестр забыл бы его до ворот. */
  const liveRun = (): RunLike => ({
    start: (options: RunOptions) => {
      started.push({
        cwd: options.cwd,
        prompt: options.prompt,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      });
      return new Promise(() => undefined);
    },
    stop: () => undefined,
  });

  const startRun = (): void => {
    registry.start(
      CHAT,
      { prompt: 'Почини перенос среды', cwd: repo, sessionId: SESSION },
      { projectPath: repo, sessionId: SESSION },
    );
    detach = registry.attach(CHAT, 0, {
      send: ({ event }) => void events.push(event),
      close: () => undefined,
    }) as (() => void) | undefined;
  };

  /** Запрос прав от мини-MCP-сервера: ответ придёт не сразу — его держат ворота. */
  const askPermission = (toolName = 'Edit', input: unknown = { file_path: 'a.txt' }) =>
    app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: CHAT, toolName, input, toolUseId: 'tool-1' },
    });

  const decide = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/chat/${CHAT}/branch-decision`, payload });

  /**
   * Дождаться карточки в потоке. Ждать ОТВЕТА на запрос прав здесь нельзя: он и
   * не придёт — вызов придержан до решения человека, и в этом весь смысл.
   */
  const waitFor = async (kind: ChatEvent['kind']): Promise<ChatEvent | undefined> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = events.find((event) => event.kind === kind);
      if (found) return found;
      await new Promise((done) => setTimeout(done, 10));
    }
    return undefined;
  };
  const waitForGate = () => waitFor('branchGate');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-branch-gate-routes-'));
    repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'probe@example.com');
    git(repo, 'config', 'user.name', 'probe');
    writeFileSync(join(repo, 'a.txt'), 'раз\n', 'utf8');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'первый');

    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    started = [];
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
  });

  afterEach(async () => {
    detach?.();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('первая правка в основной копии придержана карточкой, а не применена', async () => {
    startRun();
    const pending = askPermission();

    const gate = await waitForGate();
    expect(gate).toBeDefined();
    expect(gate).toMatchObject({ kind: 'branchGate', toolUseId: 'tool-1', cwd: repo });
    // Имя ветки предложено по заданию прогона — человеку останется поправить.
    expect((gate as { branch: string }).branch).toBe('agent/pochini-perenos-sredy-techat');
    // Пока человек не ответил, вызов ЖИВ: ни разрешения, ни отказа агенту ещё
    // не ушло — иначе правка успела бы примениться в общей копии.
    expect(events.some((event) => event.kind === 'permissionResolved')).toBe(false);

    session.decidePermission(CHAT, 'tool-1', { behavior: 'deny', message: 'конец теста' });
    await pending;
  });

  it('«завести копию» — копия на диске, тот же чат поднимается в ней', async () => {
    startRun();
    const pending = askPermission();
    await waitForGate();

    const response = await decide({ toolUseId: 'tool-1', choice: 'copy', branch: 'agent/proba' });

    expect(response.statusCode).toBe(200);
    const copyPath = (response.json() as { path: string }).path;
    expect(existsSync(copyPath)).toBe(true);
    expect(copyPath).toContain('repo-worktrees');
    // Ветка у копии — та, что назвал человек.
    expect(git(copyPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('agent/proba');

    // Придержанный вызов отклонён, и текст отказа говорит агенту, КУДА переехала
    // работа: он уедет результатом инструмента в транскрипт.
    const answer = (await pending).json() as { behavior: string; message: string };
    expect(answer.behavior).toBe('deny');
    expect(answer.message).toContain(copyPath);

    // Прогон поднят ЗАНОВО и в копии: тот же чат, та же сессия, новый каталог.
    expect(started).toHaveLength(2);
    expect(started[1]?.cwd).toBe(copyPath);
    expect(started[1]?.sessionId).toBe(SESSION);
    expect(started[1]?.prompt).toContain(copyPath);
  });

  it('«писать здесь» — правка проходит, и второй раз не спрашивают', async () => {
    startRun();
    const pending = askPermission();
    await waitForGate();

    const response = await decide({ toolUseId: 'tool-1', choice: 'here' });

    expect(response.statusCode).toBe(200);
    expect(((await pending).json() as { behavior: string }).behavior).toBe('allow');
    // Копия не заводилась: человек сказал «здесь».
    expect(existsSync(join(root, 'repo-worktrees'))).toBe(false);
    expect(started).toHaveLength(1);

    // Вторая правка того же прогона идёт без карточки ВЕТКИ: ответ был про
    // прогон, а не про один файл. Обычные права её по-прежнему спрашивают —
    // тумблер автоподтверждения выключен, — поэтому отпускаем её руками.
    events.length = 0;
    const second = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: CHAT, toolName: 'Edit', input: { file_path: 'b.txt' }, toolUseId: 'two' },
    });
    expect(await waitFor('permission')).toBeDefined();
    expect(events.some((event) => event.kind === 'branchGate')).toBe(false);
    session.decidePermission(CHAT, 'two', { behavior: 'deny', message: 'конец теста' });
    await second;
  });

  it('правило включено — ворот нет вовсе', async () => {
    store.updateSettings({ autoApproveRules: { editInMainCopy: true } });
    startRun();

    const response = askPermission();

    // Ворота молчат: дальше вызов идёт обычной дорогой прав. Тумблер
    // автоподтверждения выключен, поэтому это обычная карточка «Разрешить», а
    // не карточка ветки.
    expect(await waitFor('permission')).toBeDefined();
    expect(events.some((event) => event.kind === 'branchGate')).toBe(false);
    session.decidePermission(CHAT, 'tool-1', { behavior: 'deny', message: 'конец теста' });
    await response;
  });

  it('прогон уже в копии — ворота молчат: ветка у него своя', async () => {
    const copy = join(root, 'repo-worktrees', 'ready');
    git(repo, 'worktree', 'add', '-b', 'ready', copy);
    registry.start(
      CHAT,
      { prompt: 'правка в копии', cwd: copy, sessionId: SESSION },
      { projectPath: copy, sessionId: SESSION },
    );
    detach = registry.attach(CHAT, 0, {
      send: ({ event }) => void events.push(event),
      close: () => undefined,
    }) as (() => void) | undefined;

    const response = askPermission();

    expect(await waitFor('permission')).toBeDefined();
    expect(events.some((event) => event.kind === 'branchGate')).toBe(false);
    session.decidePermission(CHAT, 'tool-1', { behavior: 'deny', message: 'конец теста' });
    await response;
  });

  it('git отказал в имени ветки — карточка остаётся, вызов всё ещё придержан', async () => {
    startRun();
    const pending = askPermission();
    await waitForGate();

    const response = await decide({ toolUseId: 'tool-1', choice: 'copy', branch: 'не ..имя' });

    expect(response.statusCode).toBe(400);
    // Прогон не тронут: ни остановки, ни перезапуска — человек поправит имя.
    expect(started).toHaveLength(1);
    expect(events.some((event) => event.kind === 'permissionResolved')).toBe(false);

    session.decidePermission(CHAT, 'tool-1', { behavior: 'deny', message: 'конец теста' });
    await pending;
  });

  describe('работа отдана группам (Д15)', () => {
    /**
     * Дети чинят MR, чья ветка есть только у удалённого — как у копии MR в
     * detached HEAD (Д2). Дерево детей — через ту же сборку, что в bootstrap.
     */
    const handToChildren = (): void => {
      const remote = join(root, 'remote.git');
      git(root, 'init', '--bare', remote);
      git(repo, 'remote', 'add', 'origin', remote);
      git(repo, 'checkout', '-b', 'mr-feature');
      writeFileSync(join(repo, 'mr.txt'), 'правка MR\n', 'utf8');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'MR');
      git(repo, 'push', 'origin', 'mr-feature');
      git(repo, 'checkout', 'main');
      git(repo, 'branch', '-D', 'mr-feature');
      registry.setBranchGateContextResolver((keys) =>
        branchGateContext(
          keys.includes(SESSION)
            ? {
                parentChatId: SESSION,
                order: [0],
                groups: [
                  {
                    index: 0,
                    title: 'Шапка',
                    branch: 'mr-feature',
                    after: [],
                    status: 'started',
                    chatId: 'child-1',
                  },
                ],
              }
            : undefined,
          (chatId) =>
            chatId === 'child-1' ? { branch: 'mr-feature', remote: 'origin' } : undefined,
        ),
      );
    };

    it('карточка называет группы и ветку MR, от которой встанет копия', async () => {
      handToChildren();
      startRun();
      const pending = askPermission();

      expect(await waitForGate()).toMatchObject({
        children: [{ number: 1, title: 'Шапка', branch: 'mr-feature', status: 'started' }],
        base: 'origin/mr-feature',
      });

      session.decidePermission(CHAT, 'tool-1', { behavior: 'deny', message: 'конец теста' });
      await pending;
    });

    it('«завести копию» — копия от ветки MR, а не от main', async () => {
      handToChildren();
      startRun();
      const pending = askPermission();
      await waitForGate();

      const response = await decide({ toolUseId: 'tool-1', choice: 'copy', branch: 'agent/proba' });

      expect(response.statusCode).toBe(200);
      const copyPath = (response.json() as { path: string }).path;
      // Код MR в копии есть: она отведена от его ветки.
      expect(existsSync(join(copyPath, 'mr.txt'))).toBe(true);
      expect(git(copyPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('agent/proba');
      await pending;
    });

    it('«не писать» — отказ говорит агенту передать правку группе', async () => {
      handToChildren();
      startRun();
      const pending = askPermission();
      await waitForGate();

      await decide({ toolUseId: 'tool-1', choice: 'stop' });

      const answer = (await pending).json() as { behavior: string; message: string };
      expect(answer.behavior).toBe('deny');
      expect(answer.message).toContain('agentdeck:tell N');
      expect(answer.message).toContain('1 — «Шапка»');
    });
  });
});
