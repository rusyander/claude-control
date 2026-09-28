import Fastify, { type FastifyInstance } from 'fastify';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { registerCodedErrors } from '../../lib/server-text.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { ProjectRunnerRegistry } from '../../domains/project-runner.ts';
import { WorktreeBootstraps } from '../../domains/project-git/bootstrap.ts';
import { registerProjectRoutes } from '../project-routes.ts';
import { registerProjectGitRoutes } from '../project-git-routes.ts';
import { registerProjectRunnerRoutes } from '../project-runner-routes.ts';
import { registerProjectFilesRoutes } from '../project-files-routes.ts';
import { registerGroupRoutes } from '../group-routes.ts';
import { registerGroupSourcesRoutes } from '../group-sources-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Стенд действий агента над проектом (U4a): настоящий Fastify с теми
 * маршрутами окна, которыми действия исполняются, настоящий git и настоящий
 * реестр dev-серверов — всё во ВРЕМЕННЫХ каталогах. Глобальный конфиг git
 * владельца отключён: его excludesfile и шаблоны меняли бы счёт правок.
 * Без vitest: стенд поднимает и дочерний процесс (проверка «родитель панели»).
 */

export const ORIGIN = 'http://localhost:8888';

export const GIT_AVAILABLE = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

export interface ProjectStand {
  app: FastifyInstance;
  store: AppStore;
  appData: string;
  /** Каталог проекта (реальное написание на диске). */
  projectDir: string;
  projectId: string;
  runners: ProjectRunnerRegistry;
  call: (name: string, input: unknown) => Promise<PanelActionResult>;
  /** Вызов с карточкой: ждёт её, решает и возвращает карточку и итог. */
  decided: (
    name: string,
    input: unknown,
    decision?: 'approve' | 'reject',
  ) => Promise<{ card: PanelPendingAction; result: PanelActionResult }>;
  git: (cwd: string, ...args: string[]) => string;
  /**
   * Всё, что действие могло бы записать: файлы проекта, его копий и данных
   * панели (кроме следа агента и индекса git — его обновляет и чтение
   * `git status`), плюс реестр запущенных dev-серверов.
   */
  snapshot: () => Promise<Record<string, string>>;
  /**
   * Карточка показана, человек меняет цель, потом одобряет: итог и снимки
   * «сразу после правки человека» и «после клика».
   */
  stale: (
    name: string,
    input: unknown,
    humanEdit: () => unknown,
  ) => Promise<{
    card: PanelPendingAction;
    result: PanelActionResult;
    edited: Record<string, string>;
    after: Record<string, string>;
  }>;
  close: () => Promise<void>;
}

/** Не запись действия: след агента, индекс git (его освежает `git status`), замки. */
const UNWATCHED = /(^|\/)(agent-actions\.jsonl|index|[^/]+\.lock)$/;

function hashTree(root: string, into: Record<string, string>, label: string): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const key = `${label}/${relative(root, path).replace(/\\/g, '/')}`;
    if (UNWATCHED.test(key)) continue;
    into[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
}

const GIT_ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;

/** Удалить каталог, дождавшись, пока вышедшие процессы его отпустят (до 15 с). */
async function removeWhenReleased(dir: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || Date.now() > deadline) throw error;
      await new Promise((sleep) => setTimeout(sleep, 250));
    }
  }
}

export async function openProjectStand(): Promise<ProjectStand> {
  const appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-u4a-appdata-')));
  const projectDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-u4a-project-')));
  const saved = Object.fromEntries(GIT_ENV_KEYS.map((key) => [key, process.env[key]]));
  const gitConfig = join(appData, 'gitconfig');
  writeFileSync(gitConfig, '');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  const store = new AppStore(appData);
  const project = store.addProject({ id: 'u4a', name: 'Проект U4a', path: projectDir });
  const pending = new PanelPendingActions(10_000);
  const runners = new ProjectRunnerRegistry({ openBrowser: () => {} });
  const ctx = {
    store,
    location: {
      paths: {
        appData,
        root: appData,
        settings: join(appData, 'settings.json'),
        mcpConfig: join(appData, '.claude.json'),
      },
    },
    backupDir: join(appData, 'backups'),
    effectiveSettings: () => store.getSettings(),
    worktreeBootstraps: new WorktreeBootstraps(join(appData, 'worktree-logs')),
  } as unknown as ServerContext;
  const access = {
    allowedOrigins: allowedOrigins(8888),
    requiresToken: () => false,
    expectedToken: () => '',
  };
  const app = Fastify();
  registerAccessGate(app, access);
  registerEmptyBodyGuard(app);
  registerCodedErrors(app);
  registerProjectRoutes(app, ctx);
  registerProjectGitRoutes(app, ctx, new ChatRunRegistry());
  registerProjectRunnerRoutes(app, ctx, runners);
  registerProjectFilesRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  // Модели на стенде нет: разбор групп и совет слияния сюда не ходят.
  registerGroupSourcesRoutes(app, ctx, () => {
    throw new Error('no model on the test stand');
  });
  registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
  await app.ready();

  const call = async (name: string, input: unknown) =>
    (
      await app.inject({
        method: 'POST',
        url: `/api/agent/actions/${name}`,
        headers: { [PANEL_AGENT_HEADER]: '1' },
        payload: { input, conversationId: 'conv-u4a' },
      })
    ).json<PanelActionResult>();

  const waitPending = async (): Promise<PanelPendingAction | undefined> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const [first] = (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json<
        PanelPendingAction[]
      >();
      if (first) return first;
      await new Promise((done) => setTimeout(done, 10));
    }
    return undefined;
  };

  const decided: ProjectStand['decided'] = async (name, input, decision = 'approve') => {
    const running = call(name, input);
    const card = await Promise.race([
      waitPending(),
      running.then((result) => {
        throw new Error(`${name}: no card, the call ended as ${JSON.stringify(result)}`);
      }),
    ]);
    if (!card) throw new Error(`${name}: the card never appeared`);
    const answer = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision },
    });
    if (answer.statusCode !== 200)
      throw new Error(`${name}: decision answered ${answer.statusCode}`);
    return { card, result: await running };
  };

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

  const snapshot = async (): Promise<Record<string, string>> => {
    const files: Record<string, string> = {};
    hashTree(projectDir, files, 'project');
    hashTree(`${projectDir}-worktrees`, files, 'copies');
    hashTree(appData, files, 'appData');
    const runs = (await app.inject({ method: 'GET', url: '/api/project-runner' })).json<
      Array<{ path: string; status: string; startedAt?: string | number }>
    >();
    for (const run of runs) files[`runner/${run.path}`] = `${run.status} ${run.startedAt ?? ''}`;
    return files;
  };

  const stale: ProjectStand['stale'] = async (name, input, humanEdit) => {
    const running = call(name, input);
    const card = await Promise.race([
      waitPending(),
      running.then((result) => {
        throw new Error(`${name}: no card, the call ended as ${JSON.stringify(result)}`);
      }),
    ]);
    if (!card) throw new Error(`${name}: the card never appeared`);
    await humanEdit();
    const edited = await snapshot();
    const answer = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    if (answer.statusCode !== 200)
      throw new Error(`${name}: decision answered ${answer.statusCode}`);
    const result = await running;
    return { card, result, edited, after: await snapshot() };
  };

  const close = async () => {
    pending.cancelAll();
    runners.stopAll();
    await app.close();
    for (const key of GIT_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    // Дерево dev-сервера гасится асинхронно (`taskkill /T`), и под нагрузкой
    // полного прогона внук ещё держал каталог, когда синхронные повторы кончались.
    for (const dir of [appData, projectDir, `${projectDir}-worktrees`]) {
      await removeWhenReleased(dir);
    }
  };

  return {
    app,
    store,
    appData,
    projectDir,
    projectId: project.id,
    runners,
    call,
    decided,
    git,
    snapshot,
    stale,
    close,
  };
}

/** Репозиторий с одним коммитом в каталоге проекта. */
export function initRepo(stand: ProjectStand): void {
  const { git, projectDir } = stand;
  git(projectDir, 'init', '--initial-branch=main');
  git(projectDir, 'config', 'user.email', 'qa@example.com');
  git(projectDir, 'config', 'user.name', 'QA');
  git(projectDir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(projectDir, 'a.txt'), 'one\n');
  git(projectDir, 'add', 'a.txt');
  git(projectDir, 'commit', '-m', 'init');
}
