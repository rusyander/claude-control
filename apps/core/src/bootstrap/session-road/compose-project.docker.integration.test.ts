import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../../adapters/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps } from '../../journal/__fixtures__/journal-harness.ts';
import { CONTAINER_CALLS_FILE, runContainerWrapper } from '../../mcp/container-wrap.ts';
import { resolveExecutable } from '../../platform/exec-resolve.ts';
import { COMPOSE_PROJECT_LABEL } from '../../platform/resource-scan.ts';
import { runTool } from '../../platform/run-tool.ts';
import { REAL_READERS, releaseTaskResources, scanAfterStop, takeBaseline } from './resources.ts';

/**
 * P90 живьём на настоящем Docker (G18): проект compose, названный САМИМ вызовом (`-p`), обёртка
 * не подменяет — она пишет его контейнеры до вызова, и в конце шага ресурсом задачи становится
 * только созданное после. Чужой контейнер того же проекта (создан до сессии) не снимается.
 * Ничего не подменено: обёртка, поиск, снятие и чтение назад идут через `docker` этой машины;
 * образ — локальный `agentdeck-core-linux:22` (без сети). Нет движка или образа — тест пропущен
 * и это видно в отчёте прогона, а не зелёным.
 */

const IMAGE = 'agentdeck-core-linux:22';
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
const root = mkdtempSync(join(tmpdir(), 'compose-p90-'));
const project = `adcap-p90-${randomBytes(4).toString('hex')}`;

const dk = async (args: string[], timeoutMs = 60_000) => {
  const got = await runTool(dockerFile!, args, { timeoutMs });
  if (!got.ok) throw new Error(`docker ${args.join(' ')}: ${got.reason} ${got.stderr ?? ''}`);
  return got.stdout.trim();
};

afterAll(async () => {
  if (ready) {
    // Подчистка на случай красного посреди теста: всё с меткой проекта и его сеть.
    const left = await runTool(
      dockerFile!,
      ['ps', '-a', '-q', '--filter', `label=${COMPOSE_PROJECT_LABEL}=${project}`],
      { timeoutMs: 20_000 },
    );
    const ids = left.ok ? left.stdout.split(/\s+/).filter(Boolean) : [];
    if (ids.length > 0) await runTool(dockerFile!, ['rm', '-f', ...ids], { timeoutMs: 60_000 });
    await runTool(dockerFile!, ['network', 'rm', `${project}_default`], { timeoutMs: 20_000 });
  }
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(ready)('P90: a compose project named by the call itself, real docker', () => {
  it('only containers created after the first call are task resources; a pre-existing container of that project survives release', async () => {
    const pre = await dk([
      'run',
      '-d',
      '--label',
      `${COMPOSE_PROJECT_LABEL}=${project}`,
      IMAGE,
      'sleep',
      '300',
    ]);
    expect(pre).toMatch(/^[0-9a-f]{64}$/);

    const registry = createTaskRegistry(join(root, 'tasks'), deps());
    const task = await registry.create(CREATED);
    const session = seedSession(task, { stepKind: 'work' });
    const dir = join(root, 'session');
    mkdirSync(dir, { recursive: true });
    const baseline = await takeBaseline(
      {
        task,
        sessionId: session.sessionId,
        stateDir: join(root, 'core-state'),
        cwd: root,
        engines: ['docker'],
      },
      REAL_READERS,
    );

    const yml = join(root, 'compose.yml');
    writeFileSync(
      yml,
      ['services:', '  probe:', `    image: ${IMAGE}`, '    command: ["sleep", "300"]', ''].join(
        '\n',
      ),
    );
    const spec = Buffer.from(JSON.stringify({ real: [dockerFile], dir }), 'utf8').toString(
      'base64url',
    );
    const code = await runContainerWrapper([
      'docker',
      task.taskId,
      spec,
      'compose',
      '-p',
      project,
      '-f',
      yml,
      'up',
      '-d',
    ]);
    expect(code).toBe(0);

    const calls = readFileSync(join(dir, CONTAINER_CALLS_FILE), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(1);
    const call = JSON.parse(calls[0]!) as { kind: string; project: string; before: string[] };
    expect(call).toMatchObject({ kind: 'compose-project', project, engine: 'docker' });
    expect(call.before).toHaveLength(1);
    expect(pre.startsWith(call.before[0]!)).toBe(true);

    const handle = {
      sessionId: session.sessionId,
      dir,
      host: { pid: process.pid, start: 'test' },
    } as unknown as SessionHandle;
    const scanned = await scanAfterStop(
      {
        task,
        handle,
        tmpDir: join(root, 'no-tmp'),
        readers: REAL_READERS,
        note: () => undefined,
        baseline: { value: baseline },
      },
      { ports: [], unread: [] },
      { how: 'exited', residual: [] },
    );
    const containers = scanned.found.filter((f) => f.kind === 'container');
    expect(containers).toHaveLength(1);
    const createdId = (JSON.parse(containers[0]!.ref) as { id: string }).id;
    expect(pre.startsWith(createdId)).toBe(false);

    const released = await releaseTaskResources(task);
    expect(released.leaks).toEqual([]);
    expect(released.verified).toHaveLength(1);
    expect(await dk(['ps', '-a', '-q', '--filter', `id=${createdId}`])).toBe('');
    expect(await dk(['ps', '-a', '-q', '--filter', `id=${pre}`])).not.toBe('');

    await dk(['rm', '-f', pre]);
    registry.closeAll();
  }, 180_000);
});
