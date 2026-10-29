import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Profile } from '@agentdeck/contracts/core/records';
import { describe, expect, it } from 'vitest';
import { copyWiring } from '../../bootstrap/copy-wiring.ts';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { toSlashes } from '../../lib/glob/glob.ts';
import { samePath } from '../../platform/paths.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import {
  LOCK,
  PROFILE,
  decisions,
  git,
  installer,
  makeRepo,
  taskWithUnit,
  wiring,
} from './__fixtures__/copy-harness.ts';

/**
 * Копия единицы по настоящему пути (04:97-99): настоящий git во временном репозитории, ядро через
 * `copyWiring` — тот же вход, что у дирижёра. Подменён только запуск установщика (внешняя
 * граница: сеть реестра пакетов), и он ведёт себя как настоящий — пишет `node_modules` и
 * переписывает lock-файл.
 */

describe('unit copy setup', () => {
  it('copy from the pinned base, local layer by list, install, lock file reverted, long paths on, real-path cwd, decision journaled', async () => {
    const { repo, base, head } = makeRepo();
    const { task, unitId, branch } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    const inst = installer();
    const got = await wiring(task, root, inst.install).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error(JSON.stringify(got));
    const { decision, placed } = got.value;
    if (!placed) throw new Error('no copy placed');

    // Закреплённая база, не HEAD основной копии; ветка единицы; путь настоящий.
    expect(git(placed.dir, 'rev-parse', 'HEAD')).toBe(base);
    expect(base).not.toBe(head);
    expect(git(placed.dir, 'branch', '--show-current')).toBe(branch);
    expect(placed.dir).toBe(realpathSync.native(placed.dir));
    // Локальный слой по списку: .env.local пришёл, secrets.txt и node_modules — названы.
    expect(readFileSync(join(placed.dir, '.env.local'), 'utf8')).toBe('FEATURE_FLAG=1\n');
    expect(existsSync(join(placed.dir, 'secrets.txt'))).toBe(false);
    expect(existsSync(join(placed.dir, 'node_modules', 'x'))).toBe(false);
    // Установка — командой проекта, в копии, с пином окружения; lock-файл откачен.
    expect(inst.calls.map((c) => `${c.command} ${c.args.join(' ')}`)).toEqual([
      'pnpm install --frozen-lockfile --prefer-offline',
    ]);
    expect(samePath(inst.calls[0]!.cwd, placed.dir)).toBe(true);
    expect(existsSync(join(placed.dir, 'node_modules', 'dep'))).toBe(true);
    expect(readFileSync(join(placed.dir, 'pnpm-lock.yaml'), 'utf8')).toBe(LOCK);
    expect(git(placed.dir, 'status', '--porcelain')).toBe('');
    // Длинные пути: Windows — включены и прочитаны назад, иначе не нужны.
    if (process.platform === 'win32') {
      expect(placed.longPaths).toEqual({ value: 'on' });
      expect(git(repo, 'config', '--local', 'core.longpaths')).toBe('true');
    } else expect(placed.longPaths).toEqual({ value: 'not-needed' });

    expect(decision.verdict).toBe('ready-with-gaps');
    expect(decision.envPrepared).toBe(true);
    expect(decision.leftBehind.map((l) => `${l.kind}:${l.subject}`)).toEqual([
      'unlisted:secrets.txt',
      'build-env:node_modules/',
      'lockfiles:pnpm-lock.yaml',
    ]);
    expect(decisions(task).filter((d) => d.class === 'copy-setup')).toHaveLength(1);
    const copy = Object.values(task.state.resources).find((r) => r.kind === 'copy');
    expect(copy?.status).toBe('live');
    task.close();
  });

  it('resume after the decision is journaled: the copy is taken as is, setup and install never rerun', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    const inst = installer();
    const w = wiring(task, root, inst.install);
    const first = await w.prepare(task.taskId, unitId);
    const again = await w.prepare(task.taskId, unitId);
    if (!('value' in first) || !('value' in again)) throw new Error('prepare unread');
    expect(again.value.journaled).toBe(false);
    expect(again.value.decision).toEqual(first.value.decision);
    expect(inst.calls).toHaveLength(1);
    expect(decisions(task).filter((d) => d.class === 'copy-setup')).toHaveLength(1);
    expect(Object.values(task.state.resources).filter((r) => r.kind === 'copy')).toHaveLength(1);
    task.close();
  });

  it('install failure never blocks silently: decision failed with the log tail, journaled for the step', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId } = await taskWithUnit(repo, base);
    const out =
      'Progress: resolved 1\nERR_PNPM_FETCH_404 GET https://registry.example/x: Not Found\n';
    const inst = installer({ exit: 1, output: out });
    const got = await wiring(task, tempDir('cpw-'), inst.install).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error('prepare unread');
    const d = got.value.decision;
    expect(d.verdict).toBe('failed');
    expect(d.envPrepared).toBe(false);
    expect(d.failure?.stage).toBe('install');
    expect(d.failure?.firstError).toContain('ERR_PNPM_FETCH_404');
    expect(d.brief.join('\n')).toContain('ERR_PNPM_FETCH_404');
    const journaled = decisions(task).find((x) => x.class === 'copy-setup');
    expect(journaled?.output?.verdict).toBe('failed');
    task.close();
  });

  it('F-173: the first error comes from the whole install output, not from the 2 000-char tail of a long npm error tree', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId } = await taskWithUnit(repo, base);
    const tree = Array.from(
      { length: 80 },
      (_, i) => `npm error   peer dep-${i}@"^${i}.0.0" from consumer-${i}@1.0.0`,
    );
    const out = [
      'npm error code ERESOLVE',
      'npm error ERESOLVE unable to resolve dependency tree',
      ...tree,
      'npm error A complete log of this run can be found in: /logs/debug.log',
    ].join('\n');
    const got = await wiring(
      task,
      tempDir('cpw-'),
      installer({ exit: 1, output: out }).install,
    ).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error('prepare unread');
    const d = got.value.decision;
    expect(d.failure?.stage).toBe('install');
    // Хвост остаётся хвостом: начало дерева в него не влезает.
    expect(d.failure?.tail).not.toContain('npm error code ERESOLVE');
    expect(d.failure?.tail).toContain('A complete log of this run');
    expect(d.failure?.firstError).toBe('npm error code ERESOLVE');
    expect(d.brief.join('\n')).toContain('Failed at install: npm error code ERESOLVE');
    task.close();
  });

  it('F-175: a nested module the root tool does not install gets its own step; a uv member is covered by the root sync; generic is a note', async () => {
    const { repo, base } = makeRepo({
      'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n',
      'svc/tools/go.mod': 'module example.com/svc/tools\n\ngo 1.22\n',
      'py/pyproject.toml':
        '[project]\nname = "root"\n\n[tool.uv.workspace]\nmembers = [\n  "packages/*",\n]\nexclude = ["packages/skip"]\n',
      'py/uv.lock': 'version = 1\n',
      'py/packages/a/pyproject.toml': '[project]\nname = "a"\n',
      'py/packages/skip/pyproject.toml': '[project]\nname = "skip"\n',
      'py/scripts/pyproject.toml': '[project]\nname = "scripts"\n',
      'py/scripts/uv.lock': 'version = 1\n',
    });
    const { task, unitId } = await taskWithUnit(repo, base);
    // Только запись вызова: установщик — внешняя граница, план и его cwd — проверяемый путь.
    const calls: { cwd: string; cmd: string }[] = [];
    const install: ReturnType<typeof installer>['install'] = async (spec) => {
      calls.push({ cwd: spec.cwd, cmd: `${spec.command} ${spec.args.join(' ')}` });
      return { exit: 0, timedOut: false, ms: 1, output: 'ok' };
    };
    const stacks = [
      { stack: 'js-ts', root: '' },
      { stack: 'go', root: 'svc' },
      { stack: 'go', root: 'svc/tools' },
      { stack: 'python', root: 'py' },
      { stack: 'python', root: 'py/packages/a' },
      { stack: 'python', root: 'py/packages/skip' },
      { stack: 'python', root: 'py/scripts' },
    ];
    const profile = { value: { stacks, packageManager: null } as unknown as Profile };
    const got = await wiring(task, tempDir('cpw-'), install, profile).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error(JSON.stringify(got));
    const dir = got.value.placed?.dir ?? '';
    const where = (cwd: string): string => toSlashes(relative(dir, cwd)) || '.';
    expect(calls.map((c) => `${where(c.cwd)}: ${c.cmd}`)).toEqual([
      '.: pnpm install --frozen-lockfile --prefer-offline',
      'py: uv sync --frozen --all-packages',
      'svc: go mod download',
      'svc/tools: go mod download',
      'py/scripts: uv sync --frozen',
    ]);
    const notes = got.value.decision.leftBehind.filter((l) => l.kind === 'install-note');
    expect(notes.map((n) => n.subject)).toEqual(['python at py/packages/skip']);
    task.close();

    const g = makeRepo();
    const gt = await taskWithUnit(g.repo, g.base);
    const generic = {
      value: {
        stacks: [{ stack: 'generic', root: '' }],
        packageManager: null,
      } as unknown as Profile,
    };
    const gotG = await wiring(gt.task, tempDir('cpw-'), installer().install, generic).prepare(
      gt.task.taskId,
      gt.unitId,
    );
    if (!('value' in gotG)) throw new Error(JSON.stringify(gotG));
    const gNotes = gotG.value.decision.leftBehind.filter((l) => l.kind === 'install-note');
    expect(gNotes.map((n) => n.subject)).toEqual(['generic at .']);
    expect(gotG.value.decision.verdict).toBe('ready-with-gaps');
    gt.task.close();
  });

  it('unreadable pinned base: failed at create, journaled, no copy and no resource', async () => {
    const { repo } = makeRepo();
    const { task, unitId } = await taskWithUnit(repo, 'no-such-ref');
    const root = tempDir('cpw-');
    const got = await wiring(task, root, installer().install).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error('prepare unread');
    expect(got.value.decision.failure?.stage).toBe('create');
    expect(got.value.placed).toBeUndefined();
    expect(decisions(task).find((x) => x.class === 'copy-setup')?.output?.verdict).toBe('failed');
    expect(Object.values(task.state.resources)).toEqual([]);
    task.close();
  });

  it('a foreign directory at the copy path is refused, never removed', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId, branch } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    const target = join(root, 'copies', branch.replace('/', '-'));
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'mine.txt'), 'human file\n');
    const got = await wiring(task, root, installer().install).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error('prepare unread');
    expect(got.value.decision.failure?.stage).toBe('create');
    expect(got.value.decision.failure?.tail).toContain('foreign-dir');
    expect(readFileSync(join(target, 'mine.txt'), 'utf8')).toBe('human file\n');
    task.close();
  });

  it('removal: the main checkout and uncommitted work are refused; own layer dirt is removed and verified by read-back', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId, branch } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    const w = wiring(task, root, installer().install);
    const got = await w.prepare(task.taskId, unitId);
    if (!('value' in got) || !got.value.placed) throw new Error('prepare unread');
    const dir = got.value.placed.dir;

    expect(await w.remove(task.taskId, unitId, { repo, dir: repo, branch })).toEqual({
      ok: false,
      refused: 'the main checkout is never removed',
    });
    writeFileSync(join(dir, 'package.json'), '{"name":"edited"}\n');
    const refused = await w.remove(task.taskId, unitId, { repo, dir, branch });
    expect(refused).toEqual({ ok: false, refused: 'uncommitted work in the copy: package.json' });
    expect(existsSync(dir)).toBe(true);

    git(dir, 'checkout', '--', 'package.json');
    const removed = await w.remove(task.taskId, unitId, { repo, dir, branch });
    expect(removed.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(branch.replace('/', '-'));
    const copy = Object.values(task.state.resources).find((r) => r.kind === 'copy');
    expect(copy?.status).toBe('verified');
    task.close();
    removeVerified(root);
  });

  it('a task not live in this core is unknown, not a crash', async () => {
    const w = copyWiring({
      registry: { live: () => undefined },
      layout: { logs: tempDir() },
      profileOf: async () => PROFILE,
    });
    expect(await w.prepare('t', 'u')).toEqual({ unknown: 'task t is not live in this core' });
  });
});
