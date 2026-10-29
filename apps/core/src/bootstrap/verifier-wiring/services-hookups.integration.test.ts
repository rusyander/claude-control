import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckRequest } from '@agentdeck/contracts/core/records';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModelCheckReply } from '../../conductor/checks/index.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import type { SessionBinding } from '../../conductor/model-tools/model-tools.types.ts';
import { releaseServices } from '../../conductor/services.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { localImageOf, PG_CANDIDATES } from '../../platform/__fixtures__/engine-stub.ts';
import {
  EPHEMERAL_LABEL,
  containerPresent,
  engineHandle,
  listByLabels,
  runEngine,
  type EngineHandle,
} from '../../platform/container-engine.ts';
import { ensureCoreHome, type CoreHomeLayout } from '../../platform/core-home.ts';
import { createStandWatch } from '../../verifier/stand/index.ts';
import { buildVerifierWiring } from './index.ts';
import { queueWiring } from './queue.ts';
import { servicesWiring, type ServicesWiring } from './services.ts';

/**
 * Вставки зоны F в чужие зоны на настоящем пути: предполётная дорога `container-engine` —
 * настоящая проба движка (не «not wired»); эпоха стенда очереди — реестр стендов той же сборки;
 * проверка с `needs` идёт через `ensureServices` → контейнер задачи → адрес в `.env` копии →
 * прогон говорит с этим контейнером; без движка и в основной копии — `no-verdict` с причиной,
 * прогон не запускается. Подмена — только сам движок в двух отказах (внешняя граница).
 */

const ZONE_LABEL = 'agentdeck.zone-f-test';
// Значение метки — своё у прогона файла: уборка `afterAll` соседнего файла (параллельно) иначе
// снесла бы мой живой контейнер посреди работы (pg_dump exit 137).
const ZONE_RUN = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const roots: string[] = [];

const slack = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms * 6);
  return { cancel: () => clearTimeout(t) };
};
const engine = await engineHandle({ setTimer: slack });
const h: EngineHandle | undefined = 'value' in engine ? engine.value : undefined;
const pgImage = h ? await localImageOf(h, PG_CANDIDATES) : undefined;
const PG = pgImage ?? (PG_CANDIDATES[0] as string);
const inContainer = existsSync('/.dockerenv');

afterAll(async () => {
  if (h) {
    const left = await listByLabels(h, { [EPHEMERAL_LABEL]: '1', [ZONE_LABEL]: ZONE_RUN });
    const ids = 'value' in left ? left.value.map((row) => row.id) : [];
    if (ids.length > 0) await runEngine(h, ['rm', '-f', '-v', ...ids], { timeoutMs: 120_000 });
  }
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function git(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', ...args], { stdio: 'ignore' });
}

// Проба проверки: адрес — из `.env` своей копии, ответ — байт SSLRequest postgres ('N'/'S').
const PROBE = `import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
const env = readFileSync(new URL('.env', import.meta.url), 'utf8');
const line = env.split(/\\r?\\n/).find((l) => l.startsWith('DATABASE_URL='));
const url = new URL(line.slice('DATABASE_URL='.length));
const out = (o, code) => { writeFileSync(process.argv[2], JSON.stringify(o)); process.exit(code); };
const s = connect(Number(url.port), url.hostname);
s.on('connect', () => {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0);
  b.writeInt32BE(80877103, 4);
  s.write(b);
});
s.once('data', (d) => out({ host: url.hostname, port: url.port, answer: String.fromCharCode(d[0]) }, 0));
s.on('error', (e) => out({ host: url.hostname, port: url.port, error: e.message }, 1));
setTimeout(() => out({ error: 'timeout' }, 2), 20000);
`;

interface Stand {
  home: CoreHomeLayout;
  main: string;
  copy: string;
  out: string;
}

/** Репозиторий с compose-сервисом `db`, проверкой с `needs`, `.env` в игноре; копия — worktree. */
function repoStand(): Stand {
  const root = mkdtempSync(join(tmpdir(), 'adk-svchk-'));
  roots.push(root);
  const home = ensureCoreHome(join(root, 'home'));
  const main = join(root, 'repo');
  const copy = join(root, 'copy');
  const out = join(root, 'probe-out.json');
  mkdirSync(join(main, '.agentdeck'), { recursive: true });
  writeFileSync(join(main, 'probe.mjs'), PROBE);
  writeFileSync(join(main, '.gitignore'), '.env\n');
  writeFileSync(
    join(main, 'compose.yaml'),
    [
      'services:',
      '  db:',
      `    image: ${PG}`,
      '    ports:',
      '      - "5432:5432"',
      '    environment:',
      '      POSTGRES_DB: app',
      '      POSTGRES_PASSWORD: pw',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(main, '.agentdeck/checks.json'),
    `${JSON.stringify({
      v: 1,
      checks: [
        {
          id: 'db-probe',
          class: 'test-runner',
          argv: ['node', 'probe.mjs', out],
          requiredAt: ['publish'],
          needs: [{ service: 'db' }],
        },
      ],
    })}\n`,
  );
  execFileSync('git', ['init', '-q', '-b', 'main', main], { stdio: 'ignore' });
  git(main, 'add', '-A');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'agentdeck/copy', copy);
  // Адрес человека: проверка с ним говорить не должна — переписывается на контейнер задачи.
  const human = 'DATABASE_URL=postgres://u:p@db.human.example:5432/app\n';
  writeFileSync(join(main, '.env'), human);
  writeFileSync(join(copy, '.env'), human);
  return { home, main, copy, out };
}

async function taskIn(dir: string): Promise<{ task: LiveTask; b: SessionBinding }> {
  const { task } = await openFresh(join(dirname0(dir), `tasks-${Date.now()}`));
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: dir, baseRef: 'main' }] },
  });
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  return { task, b: bound.binding };
}

const dirname0 = (p: string): string => join(p, '..');

/** Сервисы зоны F этой сборки; движок — подменённый (отказы) или настоящий с меткой зоны теста. */
function services(
  registry: Pick<TaskRegistry, 'live'>,
  engineFact?: Parameters<ServicesWiring['ensureServices']>[1],
): Pick<ServicesWiring, 'ensureServices' | 'stands'> {
  const real = servicesWiring({ registry: registry as TaskRegistry });
  return {
    stands: real.stands,
    ensureServices: (recipes) => real.ensureServices(recipes, engineFact),
  };
}

const ran = (out: string): string | null => (existsSync(out) ? readFileSync(out, 'utf8') : null);

describe('zone F hook-ups: preflight engine road, queue stand epoch, check services', () => {
  it('preflight of the assembled wiring probes the container engine (never "not wired"); a profile without services skips it', async () => {
    const s = repoStand();
    const { task } = await taskIn(s.copy);
    const v = buildVerifierWiring({
      registry: { live: () => task } as unknown as TaskRegistry,
      layout: s.home,
    });
    const road = async (needsServices: boolean) =>
      (
        await v.profile.preflight({ needsServices, repos: [{ path: s.copy, remotes: [] }] }, {})
      ).roads.find((r) => r.road === 'container-engine');
    const on = await road(true);
    expect(on?.detail).not.toMatch(/not wired/);
    if (h) {
      expect(on).toMatchObject({ status: 'ok' });
      expect(on?.detail).toContain(h.info.serverVersion);
    } else expect(on?.status).toBe('fail');
    expect(await road(false)).toMatchObject({ status: 'skipped' });
    task.close();
  }, 60_000);

  it('the queue reads the stand epoch from the same stand registry the assembly hands to zone F', async () => {
    const s = repoStand();
    const { task } = await taskIn(s.copy);
    const v = buildVerifierWiring({
      registry: { live: () => task } as unknown as TaskRegistry,
      layout: s.home,
    });
    const parts = await v.queue.parts();
    if (!('value' in parts)) throw new Error('unknown' in parts ? parts.unknown : 'absent');
    expect(await parts.value.deps.standEpoch(task.taskId)).toBeNull();
    const codes = [200, 500];
    const watch = createStandWatch({
      health: 'http://127.0.0.1:1/health',
      intervalMs: 3_600_000,
      read: async () => ({ value: codes.shift() ?? 500 }),
    });
    v.services.stands.attach(task.taskId, watch);
    // Каждое чтение очереди — свежее: «до» здоров, «после» 500 — эпоха сдвинулась.
    const before = await parts.value.deps.standEpoch(task.taskId);
    expect(before).toBe(0);
    expect(await parts.value.deps.standEpoch(task.taskId)).not.toBe(before);
    v.services.stands.detach(task.taskId);
    task.close();
  }, 60_000);

  it('a check that needs a service, engine absent → no-verdict naming engine-absent, the check never runs', async () => {
    const s = repoStand();
    const { task, b } = await taskIn(s.copy);
    const w = queueWiring({
      registry: { live: () => task },
      layout: s.home,
      services: services({ live: () => task }, { engine: async () => ({ absent: true }) }),
    });
    const reply = (await w.check(task, b, { checkId: 'db-probe' })) as ModelCheckReply;
    expect(reply.units).toMatchObject([{ unit: '.', verdict: 'no-verdict' }]);
    expect(reply.units[0]?.reason).toMatch(/engine-absent/);
    expect(ran(s.out)).toBeNull();
    task.close();
  }, 120_000);

  it('a check that needs a service in the main checkout → no-verdict before any container (its env files stay the human ones)', async () => {
    const s = repoStand();
    const { task, b } = await taskIn(s.main);
    let asked = 0;
    const w = queueWiring({
      registry: { live: () => task },
      layout: s.home,
      services: services(
        { live: () => task },
        {
          engine: async () => {
            asked += 1;
            return { absent: true };
          },
        },
      ),
    });
    const reply = (await w.check(task, b, { checkId: 'db-probe' })) as ModelCheckReply;
    expect(reply.units).toMatchObject([{ unit: '.', verdict: 'no-verdict' }]);
    expect(reply.units[0]?.reason).toMatch(/is the main checkout/);
    expect(asked).toBe(0);
    expect(ran(s.out)).toBeNull();
    expect(readFileSync(join(s.main, '.env'), 'utf8')).toContain('db.human.example');
    task.close();
  }, 120_000);

  const pgRuns = h !== undefined && pgImage !== undefined && !inContainer;
  if (!pgRuns)
    it.skip(`real postgres skipped: ${h ? `no local ${PG}` : 'no engine'}`, () => undefined);
  it.runIf(pgRuns)(
    'a check that needs postgres in a task copy talks to the task container through the rewritten .env; the record keeps the stand epoch; task end removes the container',
    async () => {
      const s = repoStand();
      const { task, b } = await taskIn(s.copy);
      const svc = services(
        { live: () => task },
        { start: { extraLabels: { [ZONE_LABEL]: ZONE_RUN }, readyTimeoutMs: 120_000 } },
      );
      const watch = createStandWatch({
        health: 'http://127.0.0.1:1/health',
        intervalMs: 3_600_000,
        read: async () => ({ value: 200 }),
      });
      svc.stands.attach(task.taskId, watch);
      await watch.tick();
      const w = queueWiring({ registry: { live: () => task }, layout: s.home, services: svc });
      // Движок под нагрузкой готовит базу дольше бюджета ответа: модель спросила бы снова —
      // повтор присоединяется к идущему прогону, второго контейнера и прогона нет.
      let reply = (await w.check(task, b, { checkId: 'db-probe' })) as ModelCheckReply;
      for (let i = 0; i < 2 && reply.units[0]?.verdict === 'running'; i += 1) {
        reply = (await w.check(task, b, { checkId: 'db-probe' })) as ModelCheckReply;
      }
      expect(reply.units).toMatchObject([{ unit: '.', verdict: 'pass' }]);
      const probe = JSON.parse(ran(s.out) ?? '{}') as {
        host?: string;
        port?: string;
        answer?: string;
      };
      expect(probe.host).toBe('127.0.0.1');
      expect(probe.port).not.toBe('5432');
      expect(['N', 'S']).toContain(probe.answer);
      // Основная копия не тронута: её адрес — по-прежнему адрес человека.
      expect(readFileSync(join(s.main, '.env'), 'utf8')).toContain('db.human.example');
      expect(readFileSync(join(s.copy, '.env'), 'utf8')).not.toContain('db.human.example');

      const parts = await w.parts();
      if (!('value' in parts)) throw new Error('parts');
      const store = parts.value.deps.store({
        taskId: task.taskId,
        project: 'r1',
        copyDir: s.copy,
      } as CheckRequest);
      if (!('value' in store)) throw new Error('store');
      const record = store.value.record(reply.recordId as never);
      expect(record).toMatchObject({ value: { standEpoch: 0 } });
      svc.stands.detach(task.taskId);

      const containers = Object.values(task.state.resources).filter((r) => r.kind === 'container');
      expect(containers).toHaveLength(1);
      const released = await releaseServices(task);
      expect(released).toMatchObject([{ verified: expect.stringMatching(/absent$/) }]);
      const id = /container (\S+) absent/.exec((released[0] as { verified: string }).verified)?.[1];
      expect(await containerPresent(h!, id as string)).toEqual({ value: false });
      task.close();
    },
    300_000,
  );
});
