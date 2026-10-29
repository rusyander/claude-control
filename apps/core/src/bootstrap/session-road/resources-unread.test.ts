import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../../adapters/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import {
  releaseTaskResources,
  scanAfterStop,
  type Baseline,
  type ResourceReaders,
} from './resources.ts';

/**
 * Непрочитанный снимок конца шага (ревью A2r5-F05, F25): движок молчит на остановке сессии —
 * находок нет, но это не «чисто». Причина уходит в журнал задачи сигналом, а конец задачи несёт
 * её в `TaskRelease.unread`: решение конца задачи не прочтёт «утечек нет» над тем, чего не видело.
 * Подменён только читатель движка (внешняя граница), журнал и конец задачи — настоящие.
 */

const root = tempDir('res-unread-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('an unread step-end resource scan reaches the task journal and task end (A2r5-F05)', () => {
  it('silent engine at session stop → signal resources-unread in the journal, TaskRelease.unread names it', async () => {
    const registry = createTaskRegistry(join(root, 'tasks'), deps());
    const task = await registry.create(CREATED);
    const session = seedSession(task, { stepKind: 'work' });
    const dir = join(root, 'session');
    mkdirSync(dir, { recursive: true });
    const baseline: Baseline = {
      worktrees: [],
      containers: { docker: [] },
      engines: ['docker'],
      all: { docker: [] },
      cwd: dir,
    };
    const readers: ResourceReaders = {
      worktrees: async () => ({ value: [] }),
      containers: async () => ({ unknown: 'engine-down: docker ps timed out' }),
      listeners: async () => ({ value: [] }),
      sweep: async () => ({ value: [] }),
      taskLabelOf: async () => ({ value: null }),
    };
    const handle = {
      sessionId: session.sessionId,
      dir,
      host: { pid: 1, start: 'x' },
    } as unknown as SessionHandle;
    const scanned = await scanAfterStop(
      {
        task,
        handle,
        tmpDir: join(dir, 'none'),
        readers,
        note: () => undefined,
        baseline: { value: baseline },
      },
      { ports: [], unread: [] },
      { how: 'exited', residual: [] },
    );
    expect(scanned.found).toEqual([]);
    expect(scanned.unread).toEqual(['docker: engine-down: docker ps timed out']);

    const signals = readJournalLines(task.dir, task.taskId).lines.filter(
      (l) => l.kind === 'signal',
    );
    expect(signals.map((l) => l.data)).toContainEqual({
      signal: 'resources-unread',
      severity: 'warn',
      subject: session.sessionId,
      detail: 'docker: engine-down: docker ps timed out',
    });

    const released = await releaseTaskResources(task);
    expect(released.leaks).toEqual([]);
    expect(released.unread).toEqual([
      { sessionId: session.sessionId, reason: 'docker: engine-down: docker ps timed out' },
    ]);
    registry.closeAll();
  });
});
