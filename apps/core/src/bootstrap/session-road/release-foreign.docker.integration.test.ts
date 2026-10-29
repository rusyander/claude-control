import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { resolveExecutable } from '../../platform/exec-resolve.ts';
import { TASK_LABEL } from '../../platform/resource-scan.ts';
import { runTool } from '../../platform/run-tool.ts';
import { releaseTaskResources } from './resources.ts';

/**
 * P40 живьём на настоящем Docker (ревью B2r2-F01, половина снятия): находка сессии снимается в
 * конце задачи только после чтения метки `agentdeck.task` — контейнер с меткой ДРУГОЙ задачи не
 * удаляется никогда (утечка «labelled for task <x>»), без метки или с меткой этой задачи — снят и
 * прочитан назад. Ничего не подменено: журнал, конец задачи, `inspect`, `rm` и чтение назад идут
 * через `docker` этой машины; образ — локальный `agentdeck-core-linux:22`. Свои контейнеры теста
 * несут метку прогона и снимаются в `afterAll`. Нет движка или образа — тест пропущен.
 */

const IMAGE = 'agentdeck-core-linux:22';
const PROBE_LABEL = 'agentdeck.fixprobe';
const docker = resolveExecutable('docker');
const dockerFile = docker.ok ? docker.file : undefined;

async function dockerReady(): Promise<boolean> {
  if (!dockerFile) return false;
  const got = await runTool(dockerFile, ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], {
    timeoutMs: 20_000,
  });
  return got.ok;
}

const ready = await dockerReady();
const root = mkdtempSync(join(tmpdir(), 'release-foreign-'));
const probe = `rf-${randomBytes(4).toString('hex')}`;

const dk = async (args: string[], timeoutMs = 60_000) => {
  const got = await runTool(dockerFile!, args, { timeoutMs });
  if (!got.ok) throw new Error(`docker ${args.join(' ')}: ${got.reason} ${got.stderr ?? ''}`);
  return got.stdout.trim();
};

afterAll(async () => {
  if (ready) {
    const left = await runTool(
      dockerFile!,
      ['ps', '-a', '-q', '--filter', `label=${PROBE_LABEL}=${probe}`],
      { timeoutMs: 20_000 },
    );
    const ids = left.ok ? left.stdout.split(/\s+/).filter(Boolean) : [];
    if (ids.length > 0) await runTool(dockerFile!, ['rm', '-f', ...ids], { timeoutMs: 60_000 });
  }
  rmSync(root, { recursive: true, force: true });
});

async function start(labels: Record<string, string>): Promise<string> {
  const args = ['run', '-d', '--label', `${PROBE_LABEL}=${probe}`];
  for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
  const id = await dk([...args, IMAGE, 'sleep', '300']);
  expect(id).toMatch(/^[0-9a-f]{64}$/);
  return id;
}

function foundBySession(task: LiveTask, sessionId: string, id: string): string {
  const rid = newId();
  task.append({
    kind: 'resource.created',
    actor: 'core',
    sessionId,
    data: {
      rid,
      kind: 'container',
      owner: 'session',
      release: 'task-end',
      ref: JSON.stringify({ engine: 'docker', id: id.slice(0, 12) }),
    },
  });
  return rid;
}

const present = async (id: string) => (await dk(['ps', '-a', '-q', '--filter', `id=${id}`])) !== '';

describe.runIf(ready)(
  'P40 session container release reads the task label first, real docker',
  () => {
    it("another task's container is never removed (leak names the task); unlabelled and own are removed and read back", async () => {
      const registry = createTaskRegistry(join(root, 'tasks'), deps());
      const task = await registry.create(CREATED);
      const session = seedSession(task, { stepKind: 'work' });
      const other = 'other-task-0001';
      const foreign = await start({ [TASK_LABEL]: other });
      const own = await start({ [TASK_LABEL]: task.taskId });
      const bare = await start({});
      const foreignRid = foundBySession(task, session.sessionId, foreign);
      const ownRid = foundBySession(task, session.sessionId, own);
      const bareRid = foundBySession(task, session.sessionId, bare);

      const released = await releaseTaskResources(task);

      expect(released.leaks).toEqual([
        { rid: foreignRid, reason: expect.stringContaining(`labelled for task ${other}`) },
      ]);
      expect(released.verified.map((v) => v.rid).sort()).toEqual([ownRid, bareRid].sort());
      expect(await present(foreign)).toBe(true);
      expect(await present(own)).toBe(false);
      expect(await present(bare)).toBe(false);
      registry.closeAll();
    }, 180_000);
  },
);
