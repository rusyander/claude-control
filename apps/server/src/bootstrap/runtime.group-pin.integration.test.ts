import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { AppStore } from '../lib/app-store.ts';
import { projectKey, updateGroupSources } from '../lib/app-store/group-sources.ts';
import type { ServerContext } from '../context.ts';
import type { RunLike } from '../domains/chat/ChatRunRegistry.ts';
import type { ChatLink } from '../lib/app-store/app-store.types.ts';
import { stageOf } from '../domains/chat/ChatCascadeStages.ts';
import { registerChatRunRoutes } from '../routes/chat/run-routes.ts';
import { registerChatSplitRoutes } from '../routes/chat/split-routes.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * F-107 на точках входа (холодная проверка V-S): закрепление группы, сделанное,
 * пока его сторона пары действовала, сверяется с парой ОСНОВНОГО проекта по
 * каталогу прогона. Сверку проверяли только юнит-тесты функций, а её проводку —
 * никто: каталог прогона, подменённый на «нет» в сборке `runtime.ts`
 * (`stepsAt`, `groupKnobs`), в планировщике звеньев, в маршруте отправки и в
 * старте ребёнка разделения, оставлял набор зелёным, и прогон снова шёл по
 * шагам неактивной половины.
 *
 * Сборка настоящая — `createRuntime`, маршруты отправки и разделения,
 * планировщик звеньев, хранилище и выбор стороны на диске, настоящий
 * `git worktree` (прогон идёт в копии, выбор записан на основной). Подменён только
 * процесс CLI (фабрика прогонов реестра).
 */

const PARENT = 'родитель';
const ts = '2026-09-28T10:00:00.000Z';

function step(id: string, anchor: PathStep['anchor']): PathStep {
  return {
    id,
    anchor,
    order: 0,
    kind: 'prompt',
    title: { ru: `Шаг ${id}`, en: `Step ${id}` },
    prompt: { ru: `Сделай ${id}`, en: `Do ${id}` },
    source: 'ru',
    createdAt: ts,
  };
}

const group = (patch: Partial<Group>): Group =>
  ({
    id: 'g',
    name: 'Набор',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: false,
    order: 0,
    when: '',
    ...patch,
  }) as Group;

const linkAt = (stage: ChatLink['stage']): ChatLink => ({
  parentChatId: PARENT,
  createdAt: '2020-01-01T00:00:00.000Z',
  title: 'Переименования',
  branch: 'feat',
  groupIndex: 0,
  model: 'sonnet',
  effort: 'medium',
  kind: 'mechanical',
  lowered: true,
  stage,
  ceilingModel: 'claude-opus-5',
  workModel: 'sonnet',
  workEffort: 'medium',
});

interface Started {
  chatId: string;
  prompt: string;
  cwd: string;
  append: string;
  /** Стадия связи В МОМЕНТ запуска: дети разделения стартуют планом или работой. */
  stage?: string;
}

describe('закрепление группы сверяется с парой основного проекта на точках входа (F-107)', () => {
  let root: string;
  let repo: string;
  let copy: string;
  let appData: string;
  let store: AppStore;
  let runtime: Runtime;
  let app: FastifyInstance;
  let started: Started[];
  let counter: number;

  beforeEach(async () => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-pin-')));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    // Прогон звена идёт в копии репозитория, а выбор стороны пары записан на
    // основной проект: по каталогу копии его не найти без `layoutForCwd`.
    repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'p@example.com');
    git(repo, 'config', 'user.name', 'p');
    writeFileSync(join(repo, 'a.txt'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    copy = join(root, 'repo-wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat', copy);

    store = new AppStore(appData);
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
    counter = 0;
    // Единственная подмена — процесс CLI: фабрика прогонов реестра из сборки.
    // Работа оставляет правку в копии, иначе ревью заводить не на что.
    const stageAt = (chatId: string) => {
      const link = store.getChatLink(chatId);
      return link ? stageOf(link) : undefined;
    };
    const fake = (): RunLike => ({
      start: async (options, onEvent) => {
        counter += 1;
        started.push({
          chatId: options.permissionPrompt?.runId ?? '',
          prompt: options.prompt,
          cwd: options.cwd,
          append: options.appendSystemPrompt ?? '',
          stage: stageAt(options.permissionPrompt?.runId ?? ''),
        });
        writeFileSync(join(options.cwd, `edit-${counter}.txt`), 'y\n');
        onEvent({ kind: 'text', text: 'Готово.' });
        onEvent({
          kind: 'done',
          costUsd: 0,
          durationMs: 1,
          sessionId: options.sessionId ?? `sess-${counter}`,
        });
      },
      stop: () => undefined,
    });
    (runtime.chatRuns as unknown as { createRun: () => RunLike }).createRun = fake;

    app = Fastify();
    registerChatRunRoutes(app, ctx, runtime.chatRuns, runtime.chatSession);
    // Разделение — теми же объектами, что в таблице маршрутов (`route-table.ts`).
    registerChatSplitRoutes(app, ctx, {
      runs: runtime.chatRuns,
      providerChats: runtime.providerChats,
      session: runtime.chatSession,
      gate: runtime.treePause,
      conveyor: runtime.splitConveyor,
      overlap: runtime.splitOverlap,
      review: runtime.splitReview,
      asks: runtime.pendingAsks,
    });
    await app.ready();

    // Закреплено у корня дерева, пока действовала глобальная сторона; выбора на
    // основном проекте сейчас нет — действует проектная.
    store.setChatGroupSettings(PARENT, { groupChoice: 'global:mine-copy' });
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await app.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** Пара основного проекта: проектная и её глобальная копия, у каждой свои шаги. */
  const savePair = (anchor: PathStep['anchor'], flow?: Group['flow']): void => {
    const scope = { kind: 'project', path: repo, provider: 'claude' } as const;
    store.saveGroup(
      group({
        id: 'mine',
        name: 'Проектная',
        scope,
        order: 1,
        ...(flow ? { flow } : {}),
        path: { steps: [step('project-side', anchor)] },
      }),
    );
    store.saveGroup(
      group({
        id: 'mine-copy',
        name: 'Глобальная копия',
        origin: { groupId: 'mine', scope, hash: 'h' },
        order: 2,
        ...(flow ? { flow } : {}),
        path: { steps: [step('global-side', anchor)] },
      } as Partial<Group>),
    );
  };
  const chooseGlobal = (): void =>
    updateGroupSources(appData, (state) => {
      state.choices[projectKey(repo)] = 'global:mine-copy';
    });

  async function send(chatId: string, prompt: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/send',
      payload: { chatId, prompt, projectPath: copy },
    });
    expect(response.statusCode).toBe(200);
    for (let i = 0; i < 100 && runtime.chatRuns.isRunning(chatId); i += 1) {
      await new Promise((done) => setTimeout(done, 20));
    }
    await new Promise((done) => setTimeout(done, 100));
  }

  it('шаг «Пути» после стадии (runtime stepsAt) — действующей стороны', async () => {
    savePair('fix');
    store.setChatLink('чат-правок', linkAt('fix'));
    await send('чат-правок', 'Поправь по замечаниям');

    const step = started.find((run) => run.prompt.includes('Do '));
    expect(step?.prompt).toContain('Do project-side');
    expect(step?.prompt).not.toContain('global-side');
  });

  it('ревью после работы (runtime groupKnobs) — строка сценария действующей стороны', async () => {
    savePair('fix', 'scenario');
    store.setChatLink('чат-работы', linkAt('work'));
    await send('чат-работы', 'Переименуй функцию');

    // Своя дописка работы (маршрут отправки, строка скиллов звена).
    expect(started[0]?.append).toContain('Do project-side');
    expect(started[0]?.append).not.toContain('global-side');
    // Ревью заведено планировщиком звеньев — с той же стороной пары.
    const review = started.find((run) => store.getChatLink(run.chatId)?.stage === 'review');
    expect(review).toBeDefined();
    expect(review?.cwd).toBe(copy);
    expect(review?.append).toContain('Do project-side');
    expect(review?.append).not.toContain('global-side');
  });

  it('обычный чат (подсказка пути в маршруте отправки) — действующей стороны, и за выбором следует', async () => {
    savePair('review');
    store.setChatGroupSettings('обычный', { groupChoice: 'global:mine-copy' });
    await send('обычный', 'Сделай задачу');
    expect(started[0]?.append).toContain('Do project-side');
    expect(started[0]?.append).not.toContain('global-side');

    // Человек выбрал глобальную сторону на основном проекте — копия видит тот же выбор.
    chooseGlobal();
    store.setChatGroupSettings('обычный-2', { groupChoice: 'global:mine-copy' });
    await send('обычный-2', 'Сделай задачу');
    expect(started.at(-1)?.append).toContain('Do global-side');
  });

  it('ребёнок разделения Claude (split-launch) — строка сценария действующей стороны', async () => {
    savePair('fix', 'scenario');
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/split',
      payload: {
        projectPath: repo,
        parentChatId: PARENT,
        startRuns: true,
        proposal: {
          shared: '',
          groups: [
            { title: 'Раз', branch: 'feat-one', tasks: ['первая задача'] },
            { title: 'Два', branch: 'feat-two', tasks: ['вторая задача'] },
          ],
        },
      },
    });
    expect(response.statusCode).toBe(200);
    // Копии заводятся после ответа (`git worktree add`) — ждём оба старта.
    const childrenOf = () =>
      started.filter(
        (run) =>
          (run.stage === 'plan' || run.stage === 'work') &&
          store.getChatLink(run.chatId)?.parentChatId === PARENT,
      );
    for (let i = 0; i < 200 && childrenOf().length < 2; i += 1) {
      await new Promise((done) => setTimeout(done, 50));
    }
    await new Promise((done) => setTimeout(done, 300));
    const children = childrenOf();
    expect(children).toHaveLength(2);
    for (const child of children) {
      // Ребёнок идёт в своей копии, а выбор стороны записан на основной проект.
      expect(child.cwd).not.toBe(repo);
      expect(child.append).toContain('Do project-side');
      expect(child.append).not.toContain('global-side');
    }
  });
});
