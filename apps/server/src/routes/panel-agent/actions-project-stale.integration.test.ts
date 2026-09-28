import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Group, ProjectRunnerView } from '@agentdeck/contracts';
import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { agentJournalPath } from '../../domains/panel-agent/journal.ts';
import {
  GIT_AVAILABLE,
  initRepo,
  openProjectStand,
  type ProjectStand,
} from './project-actions.harness.ts';
import {
  freeTcpPort,
  killQuietly,
  spawnOrphanListener,
  waitListening,
} from './port-holders.harness.ts';

/**
 * Устаревшая карточка у каждого действия-правки проекта (U4a, ревью M3):
 * карточка показана, человек меняет цель, потом жмёт «Выполнить» — действие
 * обязано кончиться `stale_preview` и не записать НИЧЕГО (снимок файлов
 * проекта, его копий, данных панели и реестра dev-серверов равен снимку сразу
 * после правки человека). Строка таблицы — одно действие; по одному действию
 * каждого модуля проверено целиком: след агента, текст отказа и свежая
 * карточка после отказа, которая уже видит правку человека.
 */

const MCP_FILE = (stand: ProjectStand) => join(stand.projectDir, '.mcp.json');
const SETTINGS_FILE = (stand: ProjectStand) => join(stand.projectDir, '.claude', 'settings.json');

const writeMcp = (stand: ProjectStand, args: string[]) =>
  writeFileSync(
    MCP_FILE(stand),
    JSON.stringify({ mcpServers: { docs: { command: 'node', args } } }, null, 2),
  );

const writePermissions = (stand: ProjectStand, permissions: Record<string, string[]>) => {
  mkdirSync(join(stand.projectDir, '.claude'), { recursive: true });
  writeFileSync(SETTINGS_FILE(stand), JSON.stringify({ permissions }, null, 2));
};

const writePackage = (stand: ProjectStand, dev: string) =>
  writeFileSync(
    join(stand.projectDir, 'package.json'),
    JSON.stringify({ name: 'u4a-app', scripts: { dev } }),
  );

const SERVER_JS = `require('node:http').createServer((_q, s) => s.end('ok'))
  .listen(Number(process.env.PORT || 0), '127.0.0.1', function () {
    console.log('ready on http://localhost:' + this.address().port);
  });
`;

async function inject(stand: ProjectStand, method: 'PUT' | 'POST', url: string, payload: object) {
  const answer = await stand.app.inject({ method, url, payload });
  if (answer.statusCode !== 200) throw new Error(`${url}: ${answer.statusCode} ${answer.body}`);
}

async function permissionId(stand: ProjectStand, pattern: string): Promise<string> {
  const listed = await stand.call('list_project_permissions', { project: stand.projectId });
  const rule = (
    listed.result as { permissions: Array<{ id: string; pattern: string }> }
  ).permissions.find((item) => item.pattern === pattern);
  if (!rule) throw new Error(`no permission ${pattern}: ${JSON.stringify(listed)}`);
  return rule.id;
}

const group = (id: string, name: string, patch: Partial<Group>): Group => ({
  id,
  name,
  description: '',
  color: 'accent',
  icon: 'folder',
  members: [],
  env: {},
  projectPaths: [],
  isEnabled: true,
  order: 0,
  ...patch,
});

/** Копия проекта руками человека — там, где её ищет панель. */
function humanCopy(stand: ProjectStand, branch: string): string {
  const copy = join(`${stand.projectDir}-worktrees`, branch);
  stand.git(stand.projectDir, 'worktree', 'add', '-b', branch, copy);
  return copy;
}

const mirrorPut = (stand: ProjectStand, patch: object) =>
  inject(stand, 'PUT', '/api/project-git/mirror-settings', {
    path: stand.projectDir,
    include: [],
    exclude: [],
    ...patch,
  });

async function runnerViews(stand: ProjectStand): Promise<ProjectRunnerView[]> {
  return (await stand.app.inject({ method: 'GET', url: '/api/project-runner' })).json();
}

async function untilRunning(stand: ProjectStand): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await runnerViews(stand)).some((view) => view.status === 'running')) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('dev server never reached running');
}

interface Row {
  name: string;
  /** Модуль действия — для полной проверки одного действия каждого. */
  module: 'config' | 'git' | 'runner';
  git?: boolean;
  /** Готовит цель и возвращает вход действия. */
  setup: (stand: ProjectStand) => Promise<unknown> | unknown;
  /** Правка человека, пока карточка ждёт. */
  edit: (stand: ProjectStand, input: unknown) => Promise<unknown> | unknown;
  timeout?: number;
}

const ROWS: Row[] = [
  // --- Настройки проекта ---
  {
    name: 'save_project_claude_md',
    module: 'config',
    setup: (stand) => {
      writeFileSync(join(stand.projectDir, 'CLAUDE.md'), 'old\n');
      return { project: stand.projectId, content: 'agent\n' };
    },
    edit: (stand) => writeFileSync(join(stand.projectDir, 'CLAUDE.md'), 'human\n'),
  },
  {
    name: 'save_project_mcp_server',
    module: 'config',
    setup: (stand) => {
      writeMcp(stand, ['docs.js']);
      return {
        project: stand.projectId,
        name: 'extra',
        transport: 'stdio',
        command: 'node',
        args: ['extra.js'],
      };
    },
    edit: (stand) => writeMcp(stand, ['human.js']),
  },
  {
    name: 'delete_project_mcp_server',
    module: 'config',
    setup: (stand) => {
      writeMcp(stand, ['docs.js']);
      return { project: stand.projectId, id: 'docs' };
    },
    edit: (stand) => writeMcp(stand, ['human.js']),
  },
  {
    name: 'toggle_project_mcp_server',
    module: 'config',
    setup: (stand) => {
      writeMcp(stand, ['docs.js']);
      return { project: stand.projectId, id: 'docs', enabled: false };
    },
    edit: (stand) => writeMcp(stand, ['human.js']),
  },
  {
    name: 'add_project_permission',
    module: 'config',
    setup: (stand) => {
      writePermissions(stand, { allow: ['Read'] });
      return { project: stand.projectId, decision: 'allow', pattern: 'Bash(ls:*)' };
    },
    edit: (stand) => writePermissions(stand, { allow: ['Read', 'Write'] }),
  },
  {
    name: 'edit_project_permission',
    module: 'config',
    setup: async (stand) => {
      writePermissions(stand, { allow: ['Read'] });
      return {
        project: stand.projectId,
        id: await permissionId(stand, 'Read'),
        decision: 'ask',
        pattern: 'Read(src/**)',
      };
    },
    edit: (stand) => writePermissions(stand, { deny: ['Read'] }),
  },
  {
    name: 'remove_project_permission',
    module: 'config',
    setup: async (stand) => {
      writePermissions(stand, { allow: ['Read'] });
      return { project: stand.projectId, id: await permissionId(stand, 'Read') };
    },
    edit: (stand) => writePermissions(stand, { deny: ['Read'] }),
  },
  {
    name: 'set_project_group_choice',
    module: 'config',
    setup: (stand) => {
      const scope = { kind: 'project' as const, path: stand.projectDir, provider: 'claude' };
      stand.store.saveGroup(group('pa', 'Проектная', { scope }));
      stand.store.saveGroup(
        group('ga', 'Глобальная копия', {
          origin: { scope, groupId: 'pa', hash: 'h', copiedAt: '2026-09-28T00:00:00.000Z' },
        }),
      );
      return { project: stand.projectId, groupKey: 'global:ga' };
    },
    edit: (stand) =>
      inject(stand, 'PUT', '/api/projects/group-choice', {
        path: stand.projectDir,
        groupKey: 'project:pa',
      }),
  },
  // --- Git и копии ---
  {
    name: 'git_checkout',
    module: 'git',
    git: true,
    setup: (stand) => {
      stand.git(stand.projectDir, 'branch', 'other');
      return { project: stand.projectId, branch: 'other' };
    },
    edit: (stand) => writeFileSync(join(stand.projectDir, 'human.txt'), 'human\n'),
  },
  {
    name: 'git_create_branch',
    module: 'git',
    git: true,
    setup: (stand) => ({ project: stand.projectId, name: 'feature/agent' }),
    edit: (stand) => writeFileSync(join(stand.projectDir, 'human.txt'), 'human\n'),
  },
  {
    // Ревью m1: правка того же числа строк — счётчики git те же, текст другой.
    name: 'git_commit',
    module: 'git',
    git: true,
    setup: (stand) => {
      writeFileSync(join(stand.projectDir, 'a.txt'), 'two\n');
      return { project: stand.projectId, message: 'agent: second line' };
    },
    edit: (stand) => writeFileSync(join(stand.projectDir, 'a.txt'), 'SNEAKY\n'),
  },
  {
    name: 'git_pull',
    module: 'git',
    git: true,
    setup: (stand) => {
      const { projectDir, git, appData } = stand;
      const remote = join(appData, 'remote.git');
      git(appData, 'init', '--bare', '--initial-branch=main', remote);
      git(projectDir, 'remote', 'add', 'origin', remote);
      git(projectDir, 'push', '-u', 'origin', 'main');
      const other = join(appData, 'other');
      git(appData, 'clone', remote, other);
      git(other, 'config', 'user.email', 'qa@example.com');
      git(other, 'config', 'user.name', 'QA');
      writeFileSync(join(other, 'b.txt'), 'from remote\n');
      git(other, 'add', 'b.txt');
      git(other, 'commit', '-m', 'remote commit');
      git(other, 'push', 'origin', 'main');
      return { project: stand.projectId };
    },
    edit: (stand) => writeFileSync(join(stand.projectDir, 'human.txt'), 'human\n'),
  },
  {
    name: 'add_worktree',
    module: 'git',
    git: true,
    setup: (stand) => ({ project: stand.projectId, branch: 'copy-a' }),
    edit: (stand) => humanCopy(stand, 'human-copy'),
  },
  {
    name: 'remove_worktree',
    module: 'git',
    git: true,
    setup: (stand) => ({ project: stand.projectId, copy: humanCopy(stand, 'copy-b') }),
    edit: (_stand, input) =>
      writeFileSync(join((input as { copy: string }).copy, 'human.txt'), 'human\n'),
  },
  {
    name: 'bootstrap_worktree',
    module: 'git',
    git: true,
    setup: async (stand) => {
      await mirrorPut(stand, { bootstrap: 'node -e "1"' });
      return { project: stand.projectId, copy: humanCopy(stand, 'copy-c') };
    },
    edit: (stand) => mirrorPut(stand, { bootstrap: 'node -e "2"' }),
  },
  {
    name: 'mirror_worktree',
    module: 'git',
    git: true,
    setup: (stand) => ({ project: stand.projectId, copy: humanCopy(stand, 'copy-d') }),
    edit: (stand) => mirrorPut(stand, { include: ['local.cfg'] }),
  },
  {
    name: 'save_project_mirror_settings',
    module: 'git',
    git: true,
    setup: (stand) => ({ project: stand.projectId, include: ['agent.cfg'] }),
    edit: (stand) => mirrorPut(stand, { exclude: ['human.cfg'] }),
  },
  {
    name: 'save_project_split_settings',
    module: 'git',
    git: true,
    setup: (stand) => ({ project: stand.projectId, deliver: false }),
    edit: (stand) =>
      inject(stand, 'PUT', '/api/project-git/split-settings', {
        path: stand.projectDir,
        deliver: true,
        parallel: 2,
      }),
  },
  // --- Dev-серверы (ревью m2: подмена ТЕЛА скрипта при той же команде `npm run dev`) ---
  {
    name: 'save_project_runner_settings',
    module: 'runner',
    setup: async (stand) => {
      writePackage(stand, 'node server.js');
      return { project: stand.projectId, port: await freeTcpPort() };
    },
    edit: (stand) => writePackage(stand, 'node evil.js'),
  },
  {
    name: 'set_project_runner_autostart',
    module: 'runner',
    setup: (stand) => {
      writePackage(stand, 'node server.js');
      return { project: stand.projectId, enabled: true };
    },
    edit: (stand) => writePackage(stand, 'node evil.js'),
  },
  {
    name: 'start_project_runner',
    module: 'runner',
    setup: (stand) => {
      writePackage(stand, 'node server.js');
      writeFileSync(join(stand.projectDir, 'server.js'), SERVER_JS);
      return { project: stand.projectId };
    },
    edit: (stand) => writePackage(stand, 'node evil.js'),
  },
  {
    name: 'stop_project_runner',
    module: 'runner',
    setup: async (stand) => {
      writePackage(stand, 'node server.js');
      writeFileSync(join(stand.projectDir, 'server.js'), SERVER_JS);
      await inject(stand, 'POST', '/api/project-runner/start', { path: stand.projectDir, dir: '' });
      await untilRunning(stand);
      return { project: stand.projectId };
    },
    edit: async (stand) => {
      await inject(stand, 'POST', '/api/project-runner/stop', { path: stand.projectDir, dir: '' });
      await inject(stand, 'POST', '/api/project-runner/start', { path: stand.projectDir, dir: '' });
      await untilRunning(stand);
    },
  },
  {
    name: 'free_port',
    module: 'runner',
    setup: async () => {
      const port = await freeTcpPort();
      holders.push(await spawnOrphanListener(port));
      return { port };
    },
    edit: async (_stand, input) => {
      const port = (input as { port: number }).port;
      killQuietly(holders[0]!);
      await waitListening(port, false);
      holders.push(await spawnOrphanListener(port));
    },
    timeout: 120_000,
  },
];

/** Держатели порта, заведённые строкой `free_port` (гасятся после строки). */
const holders: number[] = [];

/**
 * По одному действию каждого модуля — проверка целиком: после отказа свежий
 * вызов строит карточку уже по правке человека, и исполняется именно она.
 */
const FULL: Record<string, (stand: ProjectStand, fresh: { card: PanelPendingAction }) => void> = {
  save_project_claude_md: (stand) =>
    expect(readFileSync(join(stand.projectDir, 'CLAUDE.md'), 'utf8')).toBe('agent\n'),
  // Коммит забрал ровно то, что лежало при свежей карточке, — правку человека.
  git_commit: (stand) => expect(stand.git(stand.projectDir, 'show', 'HEAD:a.txt')).toBe('SNEAKY'),
  // Карточка называет тело скрипта, а не только `npm run dev`.
  save_project_runner_settings: (_stand, fresh) =>
    expect(JSON.stringify(fresh.card.preview)).toContain('node evil.js'),
};

describe('panel-agent actions: project stale cards (every change/danger action)', () => {
  let stand: ProjectStand;

  beforeEach(async () => {
    stand = await openProjectStand();
  });
  afterEach(async () => {
    for (const pid of holders.splice(0)) killQuietly(pid);
    await stand.close();
  });

  it('таблица покрывает все 23 действия-правки проекта', () => {
    expect(ROWS.map((row) => row.name).sort()).toHaveLength(23);
    expect(new Set(ROWS.map((row) => row.name)).size).toBe(23);
    expect(new Set(ROWS.map((row) => row.module))).toEqual(new Set(['config', 'git', 'runner']));
  });

  for (const row of ROWS) {
    it.skipIf(row.git === true && !GIT_AVAILABLE)(
      `${row.name}: цель изменилась между карточкой и кликом — stale_preview, ни одной записи`,
      async () => {
        if (row.git) initRepo(stand);
        const input = await row.setup(stand);
        const { card, result, edited, after } = await stand.stale(row.name, input, () =>
          row.edit(stand, input),
        );
        expect(card.name, row.name).toBe(row.name);
        expect(result, row.name).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
        // Ничего не записано: всё как сразу после правки человека.
        expect(after, row.name).toEqual(edited);
        if (row.name === 'free_port') {
          const alive = holders.at(-1)!;
          expect(() => process.kill(alive, 0), 'the human’s new holder lives').not.toThrow();
        }
        const full = FULL[row.name];
        if (!full) return;

        expect(result.message).toMatch(new RegExp(`call ${row.name} again`, 'i'));
        const journal = readFileSync(agentJournalPath(stand.appData), 'utf8').trim().split('\n');
        expect(JSON.parse(journal.at(-1) ?? '{}')).toMatchObject({
          name: row.name,
          outcome: 'failed',
          decidedBy: 'human',
          messageCode: 'stale_preview',
          summaryFacts: expect.arrayContaining(['fact-stale']),
        });
        // Свежий вызов строит карточку уже по правке человека и исполняется.
        const fresh = await stand.decided(row.name, input);
        expect(fresh.result.outcome).toBe('done');
        full(stand, fresh);
      },
      row.timeout ?? 60_000,
    );
  }
});
