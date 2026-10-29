import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { CheckRequest } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModelCheckReply } from '../../conductor/checks/index.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { CREATED, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { ensureCoreHome, type CoreHomeLayout } from '../../platform/core-home.ts';
import { profileOf, profilePath, registryOf } from '../../verifier/profile/index.ts';
import { queueWiring } from './queue.ts';

/**
 * Обвязка зоны C на настоящем пути: дом ядра во временном каталоге, настоящий git-репозиторий
 * с `.agentdeck/checks.json` (реестр строит зона E — `registryOf`), ключ — настоящее дерево git,
 * прогон — настоящий node-процесс, журнал — настоящая живая задача. Подмены нет.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
}

async function stand(): Promise<{
  home: CoreHomeLayout;
  repo: string;
  counter: string;
  task: LiveTask;
  b: SessionBinding;
}> {
  const root = mkdtempSync(join(tmpdir(), 'adk-qwire-'));
  roots.push(root);
  const home = ensureCoreHome(join(root, 'home'));
  const repo = join(root, 'repo');
  const counter = join(root, 'spawns.log');
  mkdirSync(join(repo, '.agentdeck'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'probe.mjs'),
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], 'run\\n');\n",
  );
  writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(
    join(repo, '.agentdeck/checks.json'),
    `${JSON.stringify({
      v: 1,
      checks: [
        {
          id: 'probe',
          class: 'static',
          argv: ['node', 'probe.mjs', counter],
          requiredAt: ['publish'],
        },
      ],
    })}\n`,
  );
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  const { task } = await openFresh(join(root, 'tasks'));
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: repo, baseRef: 'main' }] },
  });
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  return { home, repo, counter, task, b: bound.binding };
}

const runs = (counter: string): number => {
  try {
    return readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    // Файла нет — проверка не запускалась.
    return 0;
  }
};

describe('queue wiring on a real repo, home and task (zone C)', () => {
  it('model tool check runs a project check once, replays it on the same tree, runs again after an edit; the task journal folds the run', async () => {
    const s = await stand();
    const w = queueWiring({ registry: { live: () => s.task }, layout: s.home });
    const first = (await w.check(s.task, s.b, { checkId: 'probe' })) as ModelCheckReply;
    expect(first).toMatchObject({ verdict: 'pass', units: [{ unit: '.', verdict: 'pass' }] });
    expect(first.recordId).not.toBeNull();
    expect(runs(s.counter)).toBe(1);

    const again = (await w.check(s.task, s.b, { checkId: 'probe' })) as ModelCheckReply;
    expect(again).toMatchObject({ verdict: 'pass', recordId: first.recordId });
    expect(again.reason).toContain('replay of probe@.');
    expect(runs(s.counter)).toBe(1);

    // Правка в рабочем дереве (без коммита) — другой ключ всей копии, прогон заново.
    writeFileSync(join(s.repo, 'src/a.ts'), 'export const a = 2;\n');
    const edited = (await w.check(s.task, s.b, { checkId: 'probe' })) as ModelCheckReply;
    expect(edited.verdict).toBe('pass');
    expect(edited.recordId).not.toBe(first.recordId);
    expect(runs(s.counter)).toBe(2);

    const checks = Object.values(s.task.state.checks);
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.state)).toEqual(['recorded', 'recorded']);
    expect(checks.map((c) => c.recordId)).toEqual([first.recordId, edited.recordId]);
    expect(checks.every((c) => c.run?.checkId === 'probe' && c.run.unit === '.')).toBe(true);

    const absent = (await w.check(s.task, s.b, { checkId: 'nope' })) as ModelCheckReply;
    expect(absent).toMatchObject({ verdict: 'fail', reason: 'absent: not in the registry' });
    s.task.close();
  }, 120_000);

  it('idle pre-run of a finished task runs the project check; the final request replays it', async () => {
    const s = await stand();
    const w = queueWiring({ registry: { live: () => s.task }, layout: s.home });
    const scope = {
      taskId: s.task.taskId,
      project: 'r1',
      copyDir: s.repo,
      finishedUnits: [],
    };
    expect((await w.preRun(scope)).answers).toEqual([]);
    const pre = await w.preRun({ ...scope, allFinished: true });
    expect(pre.answers.map((a) => [a.req.checkId, a.req.unit, a.answer.kind])).toEqual([
      ['probe', '.', 'ran'],
    ]);
    const final = (await w.check(s.task, s.b, { checkId: 'probe' })) as ModelCheckReply;
    expect(final.reason).toContain('replay of probe@.');
    expect(runs(s.counter)).toBe(1);
    s.task.close();
  }, 60_000);

  it('without a laid-out core home the tool refuses by name and runs nothing', async () => {
    const s = await stand();
    const w = queueWiring({ registry: { live: () => s.task }, layout: {} });
    const reply = (await w.check(s.task, s.b, { checkId: 'probe' })) as ModelCheckReply;
    expect(reply).toMatchObject({ verdict: 'refused' });
    expect(reply.reason).toContain('verifier not ready');
    expect(runs(s.counter)).toBe(0);
    s.task.close();
  });
});

describe('the check path reads the profile of a copy, never writes it (A2-F08)', () => {
  it('a check, its scope and an idle pre-run leave no profile file: only copy creation writes one, from the main repo', async () => {
    const s = await stand();
    const w = queueWiring({ registry: { live: () => s.task }, layout: s.home });
    const reply = (await w.check(s.task, s.b, { checkId: 'probe' })) as ModelCheckReply;
    expect(reply.verdict).toBe('pass');
    await w.scope({ repoKey: 'r1', path: s.repo, baseRef: 'main' });
    await w.preRun({
      taskId: s.task.taskId,
      project: 'r1',
      copyDir: s.repo,
      finishedUnits: [],
      allFinished: true,
    });
    expect(existsSync(profilePath(s.home.profiles, 'r1'))).toBe(false);
    s.task.close();
  }, 60_000);
});

describe('machine figures in doubt are journaled, not dropped (A1r3-F12)', () => {
  it('unreadable disk and memory figures write one machine-doubt line each; the check still runs', async () => {
    const s = await stand();
    const w = queueWiring({
      registry: { live: () => s.task },
      layout: s.home,
      machine: {
        diskFree: () => Promise.resolve({ unknown: 'statfs: EIO' }),
        memFree: () => ({ unknown: 'os.totalmem returned 0' }),
      },
    });
    const first = (await w.check(s.task, s.b, { checkId: 'probe' })) as ModelCheckReply;
    expect(first.verdict).toBe('pass');
    writeFileSync(join(s.repo, 'src/a.ts'), 'export const a = 3;\n');
    await w.check(s.task, s.b, { checkId: 'probe' });
    const doubts = readFileSync(join(s.home.logs, 'core.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.kind === 'machine-doubt')
      .map((l) => [l.subject, l.reason]);
    // Одна строка на смену причины, а не на каждый вызов.
    expect(doubts.sort()).toEqual([
      ['disk', 'statfs: EIO'],
      ['memory', 'os.totalmem returned 0'],
    ]);
    s.task.close();
  }, 60_000);
});

/** Сохранённый профиль репозитория, поправленный как правит его человек или будущий детектор. */
async function editProfile(
  s: { home: CoreHomeLayout; repo: string },
  edit: (p: Record<string, unknown>) => void,
): Promise<void> {
  await profileOf({ repoKey: 'r1', path: s.repo }, { profilesDir: s.home.profiles });
  const file = profilePath(s.home.profiles, 'r1');
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  edit(json);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

describe('check process env and tool versions follow the profile (A2-F04, A2-F06)', () => {
  it('A2-F06 profile pathEntries lead PATH of the check process, resolved inside the copy', async () => {
    const s = await stand();
    await editProfile(s, (p) => {
      // `../escape` — правка человека мимо копии: в PATH не идёт.
      p.pathEntries = ['node_modules/.bin', '../escape', 'svc/.venv/bin'];
    });
    const w = queueWiring({ registry: { live: () => s.task }, layout: s.home });
    const parts = await w.parts();
    if (!('value' in parts)) throw new Error(JSON.stringify(parts));
    const req = { taskId: s.task.taskId, project: 'r1', copyDir: s.repo } as CheckRequest;
    const env = await parts.value.deps.env(req);
    if (!('value' in env)) throw new Error(JSON.stringify(env));
    const pathKey = Object.keys(env.value).find((k) => k.toUpperCase() === 'PATH');
    expect(pathKey).toBeDefined();
    const dirs = (env.value[pathKey as string] ?? '').split(delimiter);
    expect(dirs.slice(0, 2)).toEqual([
      join(s.repo, 'node_modules', '.bin'),
      join(s.repo, 'svc', '.venv', 'bin'),
    ]);
    expect(dirs.some((d) => d.includes('escape'))).toBe(false);
    // Одна переменная PATH: Windows `Path` не раздваивается.
    expect(Object.keys(env.value).filter((k) => k.toUpperCase() === 'PATH')).toHaveLength(1);
    s.task.close();
  }, 60_000);

  it('A2-F04 a runtime pinned for the entry root (`node@svc`) is the one in the key', async () => {
    const s = await stand();
    const w = queueWiring({ registry: { live: () => s.task }, layout: s.home });
    const parts = await w.parts();
    if (!('value' in parts)) throw new Error(JSON.stringify(parts));
    const reg = await registryOf({ repoKey: 'r1', path: s.repo }, { profilesDir: s.home.profiles });
    if (!('value' in reg)) throw new Error(JSON.stringify(reg));
    const entry = { ...reg.value.checks[0]!, cwd: 'svc', tools: ['node'] };
    const req = { taskId: s.task.taskId, project: 'r1', copyDir: s.repo } as CheckRequest;
    const keyWith = async (version: string): Promise<string> => {
      await editProfile(s, (p) => {
        p.runtimes = {
          node: { version: '20', from: '.nvmrc' },
          'node@svc': { version, from: 'svc/.nvmrc' },
        };
      });
      const k = await parts.value.deps.key({
        req,
        entry,
        registry: reg.value,
        unit: '.',
        selection: [],
      });
      if (!('value' in k)) throw new Error(JSON.stringify(k));
      return k.value.key;
    };
    expect(await keyWith('18')).not.toBe(await keyWith('22'));
    s.task.close();
  }, 60_000);
});
