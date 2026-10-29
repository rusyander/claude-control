import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../../adapters/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { CONTAINER_CALLS_FILE, type ContainerCall } from '../../mcp/container-wrap.ts';
import { scanAfterStop, type Baseline, type ResourceReaders } from './resources.ts';

/**
 * Контейнеры без метки задачи в конце шага (G18) на поддельных читателях движка: проект compose
 * по снимку «до вызова», `kube play` по созданному за вызов, поды с меткой против снимка;
 * непрочитанное названо, не считано пустым. Журнал вызовов пишет дерево сессии — id из него
 * берётся, только если его не было до сессии и на нём нет метки другой задачи (ревью B2r4-F02,
 * B2r2-F01). Живой Docker — `compose-project.docker.integration`.
 */

const root = tempDir('unlabelled-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** id движка — шестнадцатеричное слово (`ps -q`): строка иной формы в журнале не принимается. */
const id = (n: string): string => n.padStart(12, '0');

async function scan(
  name: string,
  calls: (ContainerCall | string)[],
  baseline: Partial<Baseline>,
  readers: Partial<ResourceReaders>,
) {
  const registry = createTaskRegistry(join(root, name, 'tasks'), deps());
  const task = await registry.create(CREATED);
  const session = seedSession(task, { stepKind: 'work' });
  const dir = join(root, name, 'session');
  mkdirSync(dir, { recursive: true });
  const full: Baseline = {
    worktrees: null,
    containers: {},
    engines: ['docker', 'podman'],
    all: { docker: [], podman: [] },
    allPods: { podman: [] },
    cwd: dir,
    ...baseline,
  };
  writeFileSync(
    join(dir, CONTAINER_CALLS_FILE),
    calls.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('\n') + '\n',
  );
  const all: ResourceReaders = {
    worktrees: async () => ({ value: [] }),
    containers: async () => ({ value: [] }),
    listeners: async () => ({ value: [] }),
    sweep: async () => ({ value: [] }),
    taskLabelOf: async () => ({ value: null }),
    ...readers,
  };
  const handle = {
    sessionId: session.sessionId,
    dir,
    host: { pid: 1, start: 'x' },
  } as unknown as SessionHandle;
  const out = await scanAfterStop(
    {
      task,
      handle,
      tmpDir: join(dir, 'none'),
      readers: all,
      note: () => undefined,
      baseline: { value: full },
    },
    { ports: [], unread: [] },
    { how: 'exited', residual: [] },
  );
  const taskId = task.taskId;
  registry.closeAll();
  return {
    taskId,
    refs: out.found.filter((f) => f.kind === 'container').map((f) => JSON.parse(f.ref) as unknown),
    unread: out.unread,
  };
}

describe('unlabelled containers found at step end (G18)', () => {
  it('compose project named by the call: only ids new against its first «before» list, by id', async () => {
    const got = await scan(
      'compose',
      [
        {
          v: 1,
          at: 1,
          engine: 'docker',
          kind: 'compose-project',
          project: 'x',
          before: [id('a0')],
        },
        // Второй вызов того же проекта видел уже созданное сессией — его «до» не в счёт.
        {
          v: 1,
          at: 2,
          engine: 'docker',
          kind: 'compose-project',
          project: 'x',
          before: [id('a0'), id('a1')],
        },
      ],
      {},
      { projectContainers: async () => ({ value: [id('a0'), id('a1'), id('a2')] }) },
    );
    expect(got.refs).toEqual([
      { engine: 'docker', id: id('a1') },
      { engine: 'docker', id: id('a2') },
    ]);
  });

  it('kube play: containers and pods created during the call; repeated ids once; pods marked for pod rm', async () => {
    const got = await scan(
      'kube',
      [
        {
          v: 1,
          at: 1,
          engine: 'podman',
          kind: 'created-during',
          containers: [id('c1')],
          pods: [id('b1')],
        },
        {
          v: 1,
          at: 2,
          engine: 'podman',
          kind: 'created-during',
          containers: [id('c1')],
          pods: [],
        },
      ],
      { pods: { podman: [id('b0')] } },
      { pods: async () => ({ value: [id('b0'), id('b1'), id('b2')] }) },
    );
    expect(got.refs).toEqual([
      { engine: 'podman', id: id('c1') },
      { engine: 'podman', id: id('b1'), pod: true },
      { engine: 'podman', id: id('b2'), pod: true },
    ]);
  });

  it('a calls line is a claim: pre-existing, another task, unreadable label, foreign engine or shape → not taken, named', async () => {
    const labels: Record<string, string | null> = { [id('c3')]: 'other-task' };
    const got = await scan(
      'claims',
      [
        // Контейнер человека, бывший до сессии (полный список снимка ядра), — назван полным id.
        {
          v: 1,
          at: 1,
          engine: 'docker',
          kind: 'created-during',
          containers: [`${id('c2')}ffff`],
          pods: [],
        },
        // Создан за шаг другой задачей (её метка) и не прочитавшаяся метка.
        {
          v: 1,
          at: 1,
          engine: 'podman',
          kind: 'created-during',
          containers: [id('c3'), id('c4')],
          pods: [],
        },
        '{"v":1,"at":1,"engine":"C:\\\\evil\\\\touch.exe","kind":"created-during","containers":[],"pods":[]}',
        '{"v":1,"at":1,"engine":"docker","kind":"created-during","containers":["--all"],"pods":[]}',
      ],
      { all: { docker: [id('c2')], podman: [] } },
      {
        taskLabelOf: async (_e, cid) =>
          cid === id('c4') ? { unknown: 'engine down' } : { value: labels[cid] ?? null },
      },
    );
    expect(got.refs).toEqual([]);
    expect(got.unread).toEqual(
      expect.arrayContaining([
        `docker container ${id('c2')}ffff: existed before the session — not taken`,
        `podman container ${id('c3')}: labelled agentdeck.task=other-task — another task's, not taken`,
        `podman container ${id('c4')}: label unread (engine down) — not taken`,
        'container calls: engine C:\\evil\\touch.exe not wrapped by the core',
        'container calls: a line of a foreign shape skipped',
      ]),
    );
  });

  it('unread is named, never empty: null before, null kube lists, no reader, engine down, torn line', async () => {
    const got = await scan(
      'unread',
      [
        { v: 1, at: 1, engine: 'docker', kind: 'compose-project', project: 'a', before: null },
        { v: 1, at: 1, engine: 'docker', kind: 'compose-project', project: 'b', before: [] },
        {
          v: 1,
          at: 1,
          engine: 'podman',
          kind: 'created-during',
          containers: null,
          pods: null,
        },
        '{"torn',
      ],
      { pods: { podman: null } },
      {},
    );
    expect(got.refs).toEqual([]);
    expect(got.unread).toEqual(
      expect.arrayContaining([
        'container calls: a torn line skipped',
        'compose project a: containers before the call unread',
        'compose project b: no reader',
        'podman kube play: containers unread',
        'podman kube play: pods unread',
        'podman pods: baseline unread',
      ]),
    );
    const down = await scan(
      'down',
      [{ v: 1, at: 1, engine: 'docker', kind: 'compose-project', project: 'c', before: [] }],
      {},
      { projectContainers: async () => ({ unknown: 'daemon down' }) },
    );
    expect(down.unread).toContain('compose project c: daemon down');
  });
});
