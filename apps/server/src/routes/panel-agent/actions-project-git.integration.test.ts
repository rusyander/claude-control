import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GIT_AVAILABLE,
  initRepo,
  openProjectStand,
  type ProjectStand,
} from './project-actions.harness.ts';

/**
 * Git и рабочие копии проекта руками агента (U4a) — настоящий git во
 * ВРЕМЕННЫХ репозиториях (и «удалённый» — голый репозиторий рядом, в каталоге
 * стенда). Доказательство — состояние git после клика человека. `push` агенту
 * не дан вовсе: его вызов обязан кончаться «нет такого действия».
 */

const waitFor = async (check: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe.skipIf(!GIT_AVAILABLE)('panel-agent actions: project git', () => {
  let stand: ProjectStand;

  beforeEach(async () => {
    stand = await openProjectStand();
    initRepo(stand);
  });
  afterEach(async () => {
    await stand.close();
  });

  const settled = async (copy: string): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const log = await stand.app.inject({
        method: 'GET',
        url: `/api/project-git/worktrees/bootstrap-log?path=${encodeURIComponent(stand.projectDir)}&worktreePath=${encodeURIComponent(copy)}`,
      });
      const state = log.json<{ state: { status: string } | null }>().state;
      if (state && state.status !== 'running') return;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error('bootstrap never settled');
  };

  it('ветка, переключение, коммит — danger-карточки и git после клика', async () => {
    const { projectDir, git } = stand;
    const branch = await stand.decided('git_create_branch', {
      project: stand.projectId,
      name: 'feature/u4a',
    });
    expect(branch.card.risk).toBe('danger');
    expect(branch.result.outcome).toBe('done');
    expect(git(projectDir, 'branch', '--show-current')).toBe('feature/u4a');

    writeFileSync(join(projectDir, 'a.txt'), 'two\n');
    const commit = await stand.decided('git_commit', {
      project: stand.projectId,
      message: 'agent: second line',
    });
    expect(commit.card.risk).toBe('danger');
    expect(commit.result.outcome).toBe('done');
    expect(git(projectDir, 'log', '-1', '--format=%s')).toBe('agent: second line');
    expect(git(projectDir, 'status', '--porcelain')).toBe('');

    const back = await stand.decided('git_checkout', { project: projectDir, branch: 'main' });
    expect(back.result.outcome).toBe('done');
    expect(git(projectDir, 'branch', '--show-current')).toBe('main');
    expect(readFileSync(join(projectDir, 'a.txt'), 'utf8')).toBe('one\n');

    const clean = await stand.call('git_commit', { project: stand.projectId, message: 'empty' });
    expect(clean.outcome).toBe('failed');
  });

  it('git_pull забирает коммит из удалённого; git_push агенту не существует', async () => {
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

    const pulled = await stand.decided('git_pull', { project: stand.projectId });
    expect(pulled.card.risk).toBe('danger');
    expect(pulled.result.outcome).toBe('done');
    expect(readFileSync(join(projectDir, 'b.txt'), 'utf8')).toBe('from remote\n');

    const push = await stand.call('git_push', { project: stand.projectId });
    expect(push.outcome).toBe('unknown');
    expect(push.message).toContain('No panel action named');
  });

  it('копии: настройки зеркала, заведение с бутстрапом, повтор бутстрапа, зеркало, удаление', async () => {
    const { projectDir, git } = stand;
    writeFileSync(join(projectDir, '.gitignore'), 'local.cfg\nboot.txt\n');
    git(projectDir, 'add', '.gitignore');
    git(projectDir, 'commit', '-m', 'ignore');
    writeFileSync(join(projectDir, 'local.cfg'), 'v1\n');
    // Зеркало считает файл копии свежим, пока он не старее оригинала больше чем
    // на секунду (грубые метки времени ФС), а копия наследует метку оригинала.
    // Первая версия — заведомо в прошлом: иначе v2 ниже отличалась бы от неё
    // только временем прохода теста, и на быстрой машине (Linux) зеркало честно
    // оставляло v1 — тест держался на медлительности Windows.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(projectDir, 'local.cfg'), past, past);

    const settings = await stand.decided('save_project_mirror_settings', {
      project: stand.projectId,
      include: ['local.cfg'],
      bootstrap: `node -e "require('fs').writeFileSync('boot.txt','ok')"`,
    });
    expect(settings.card.risk).toBe('danger');
    expect(settings.result.outcome).toBe('done');
    const read = await stand.call('read_project_copy_settings', { project: stand.projectId });
    expect(read.outcome).toBe('done');
    expect(JSON.stringify(read.result)).toContain('local.cfg');

    const added = await stand.decided('add_worktree', {
      project: stand.projectId,
      branch: 'copy-a',
    });
    expect(added.result.outcome).toBe('done');
    const copy = join(`${projectDir}-worktrees`, 'copy-a');
    expect(git(copy, 'branch', '--show-current')).toBe('copy-a');
    expect(readFileSync(join(copy, 'local.cfg'), 'utf8')).toBe('v1\n');
    await waitFor(() => existsSync(join(copy, 'boot.txt')), 'bootstrap of the new copy');
    await settled(copy);

    const again = await stand.decided('bootstrap_worktree', {
      project: stand.projectId,
      copy,
    });
    expect(again.card.risk).toBe('danger');
    expect(again.result.outcome).toBe('done');
    await settled(copy);

    // Зеркало переносит только то, что в копии старее.
    writeFileSync(join(projectDir, 'local.cfg'), 'v2\n');
    const mirrored = await stand.decided('mirror_worktree', { project: stand.projectId, copy });
    expect(mirrored.result.outcome).toBe('done');
    expect(readFileSync(join(copy, 'local.cfg'), 'utf8')).toBe('v2\n');

    const foreign = await stand.call('remove_worktree', {
      project: stand.projectId,
      copy: join(projectDir, '..', 'not-a-copy'),
    });
    expect(foreign.outcome).toBe('failed');

    const removed = await stand.decided('remove_worktree', {
      project: stand.projectId,
      copy,
      force: true,
    });
    expect(removed.card.risk).toBe('danger');
    expect(removed.result.outcome).toBe('done');
    expect(existsSync(copy)).toBe(false);
    expect(git(projectDir, 'branch', '--list', 'copy-a')).toContain('copy-a');
  });

  it('разделение: deliver/parallel меняются, строки разрешений групп — решение человека — целы', async () => {
    const { projectDir, app } = stand;
    // Строки разрешений кладёт человек — маршрутом вкладки, как кнопка окна.
    const human = await app.inject({
      method: 'PUT',
      url: '/api/project-git/split-settings',
      payload: {
        path: projectDir,
        deliver: false,
        parallel: null,
        permissions: { gitHistory: 'auto' },
      },
    });
    expect(human.statusCode).toBe(200);
    const saved = await stand.decided('save_project_split_settings', {
      project: stand.projectId,
      deliver: true,
      parallel: 3,
    });
    expect(saved.card.risk).toBe('change');
    expect(saved.result.outcome).toBe('done');
    expect(saved.result.result).toMatchObject({ deliver: true, parallel: 3 });
    const view = await app.inject({
      method: 'GET',
      url: `/api/project-git/split-settings?path=${encodeURIComponent(projectDir)}`,
    });
    const humanRows = human.json<{ permissions: unknown }>().permissions;
    expect(humanRows).toMatchObject({ gitHistory: 'auto' });
    expect(view.json<{ permissions: unknown }>().permissions).toEqual(humanRows);

    const same = await stand.call('save_project_split_settings', {
      project: stand.projectId,
      deliver: true,
      parallel: 3,
    });
    expect(same.outcome).toBe('failed');
  });

  it('не репозиторий — отказ до карточки', async () => {
    const { projectDir, git } = stand;
    git(projectDir, 'checkout', '-b', 'side');
    const missing = await stand.call('git_checkout', { project: stand.projectId, branch: 'nope' });
    expect(missing.outcome).toBe('failed');
    const other = await stand.call('git_commit', { project: 'nope', message: 'x' });
    expect(other.outcome).toBe('failed');
  });
});
