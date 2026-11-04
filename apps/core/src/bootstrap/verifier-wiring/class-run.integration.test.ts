import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { CheckRecord } from '@agentdeck/contracts/core/records';
import type { ModelCheckReply } from '../../conductor/checks/index.ts';
import type { RecordStore } from '../../verifier/store/index.ts';
import {
  installer,
  makeRepo,
  taskWithUnit,
  wiring,
} from '../../conductor/copy/__fixtures__/copy-harness.ts';
import { unitCopyOf } from '../../conductor/copy/index.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { releaseServices } from '../../conductor/services.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { localImageOf, PG_CANDIDATES } from '../../platform/__fixtures__/engine-stub.ts';
import {
  EPHEMERAL_LABEL,
  engineHandle,
  listByLabels,
  runEngine,
  type EngineHandle,
} from '../../platform/container-engine.ts';
import { ensureCoreHome } from '../../platform/core-home.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { classRun } from './class-run.ts';
import { queueWiring } from './queue.ts';
import { servicesWiring } from './services.ts';

/**
 * Свои исполнители классов `contract` и `migration` (F-071/F-113) на настоящем пути — через вход
 * проверки очереди (`check` инструмента модели), тот же, что у итога и «красного до».
 *
 * `contract`: копия единицы на настоящем git; «до» — файл схемы на закреплённой базе копии,
 * «после» — в копии; ломающее изменение — красный, неломающее и новый файл — зелёный.
 * `migration`: настоящий postgres задачи (метка `claude.ephemeral` + метка прогона файла, снимается
 * в конце); чистая БД внутри него на прогон; down, вернувший схему, — зелёный, не вернувший —
 * красный. Без движка или образа postgres блок миграции пропущен с причиной.
 */

const FIX = fileURLToPath(
  new URL('../../verifier/classes/__fixtures__/contract/', import.meta.url),
);
const ZONE_LABEL = 'agentdeck.zone-f-test';
const ZONE_RUN = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const roots: string[] = [];

const slack = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms * 6);
  return { cancel: () => clearTimeout(t) };
};
const engine = await engineHandle({ setTimer: slack });
const h: EngineHandle | undefined = 'value' in engine ? engine.value : undefined;
const pgImage = h ? await localImageOf(h, PG_CANDIDATES) : undefined;
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

const logOf = (reply: ModelCheckReply): string =>
  reply.logPath
    ? gunzipSync(readFileSync(reply.logPath)).toString('utf8')
    : `(no log) ${reply.excerpt}`;

/**
 * Итог класса — из подписанной записи хранилища (`CheckRecord.classOutcome`), а не из лога: тот же
 * путь, которым его читают ядро и отчёт. Хранилище — то, что очередь открыла для копии.
 */
async function recordOf(
  w: ReturnType<typeof queueWiring>,
  copyDir: string,
  reply: ModelCheckReply,
): Promise<{ store: RecordStore; id: string; rec: CheckRecord }> {
  const parts = await w.parts();
  if (!('value' in parts)) throw new Error('verifier parts');
  const store = parts.value.deps.store({ copyDir } as never);
  if (!('value' in store)) throw new Error('record store');
  const id = reply.units[0]?.recordId;
  if (!id) throw new Error(`no record: ${JSON.stringify(reply.units)}`);
  const rec = store.value.record(id);
  if (!('value' in rec)) throw new Error(`record ${id}: ${JSON.stringify(rec)}`);
  return { store: store.value, id, rec: rec.value };
}

function bind(task: LiveTask, unitId?: string) {
  const seeded = seedSession(task, { stepKind: 'work', ...(unitId ? { unitId } : {}) });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  return bound.binding;
}

describe('class runners of zone F through the check queue', () => {
  it('contract: a breaking change of a schema against the pinned base of the copy is red; a compatible change and a new schema are green', async () => {
    const base = readFileSync(join(FIX, 'pets.base.yaml'), 'utf8');
    const checks = {
      v: 1,
      checks: [{ id: 'api', class: 'contract', argv: ['api/pets.yaml'], requiredAt: ['publish'] }],
    };
    const { repo, base: baseSha } = makeRepo({
      'api/pets.yaml': base,
      '.agentdeck/checks.json': `${JSON.stringify(checks)}\n`,
    });
    const { task, unitId } = await taskWithUnit(repo, baseSha);
    const root = tempDir('cls-contract-');
    roots.push(root);
    expect(
      'value' in (await wiring(task, root, installer().install).prepare(task.taskId, unitId)),
    ).toBe(true);
    const copy = unitCopyOf(task, unitId)!.dir;
    const b = bind(task, unitId);
    const w = queueWiring({
      registry: { live: () => task },
      layout: ensureCoreHome(join(root, 'home')),
    });
    const check = async () => (await w.check(task, b, { checkId: 'api' })) as ModelCheckReply;

    const same = await check();
    expect(same.units).toMatchObject([{ unit: '.', verdict: 'pass' }]);

    copyFileSync(join(FIX, 'pets.copy.yaml'), join(copy, 'api', 'pets.yaml'));
    const breaking = await check();
    expect(breaking.verdict).toBe('fail');
    expect(logOf(breaking)).toMatch(
      /\nBREAKING changed paths\.\/pets\.get\.parameters\.query:limit\.required: false -> true\n/,
    );
    // Машинного итога в логе нет — он в записи, под подписью.
    expect(logOf(breaking)).not.toMatch(/^outcome: /m);
    const red = await recordOf(w, copy, breaking);
    expect(red.rec.classOutcome?.class).toBe('contract');
    const redChanges = red.rec.classOutcome?.class === 'contract' ? red.rec.classOutcome.value : [];
    expect(redChanges.map((o) => [o.file, o.format])).toEqual([['api/pets.yaml', 'openapi']]);
    expect(redChanges[0]?.changes).toContainEqual({
      kind: 'changed',
      at: 'paths./pets.get.parameters.query:limit.required',
      breaking: true,
      detail: 'false -> true',
    });

    writeFileSync(join(copy, 'api', 'pets.yaml'), base.replace('title: Pets', 'title: Pets API'));
    expect((await check()).verdict).toBe('pass');

    // Новая схема: на базе файла нет — всё «добавлено», ничего не сломано.
    const fresh = { ...checks, checks: [{ ...checks.checks[0]!, argv: ['api/new.yaml'] }] };
    writeFileSync(join(copy, '.agentdeck', 'checks.json'), `${JSON.stringify(fresh)}\n`);
    copyFileSync(join(FIX, 'pets.base.yaml'), join(copy, 'api', 'new.yaml'));
    const added = await check();
    expect(added.verdict).toBe('pass');
    expect(logOf(added)).toMatch(/^api\/new\.yaml \(openapi\)/);
    expect(logOf(added)).not.toMatch(/BREAKING/);
    const fresh1 = await recordOf(w, copy, added);
    expect(fresh1.rec.classOutcome).toMatchObject({
      class: 'contract',
      value: [{ file: 'api/new.yaml', format: 'openapi', generatedDrift: null }],
    });
    const freshChanges =
      fresh1.rec.classOutcome?.class === 'contract'
        ? fresh1.rec.classOutcome.value[0]!.changes
        : [];
    expect(freshChanges.length).toBeGreaterThan(0);
    expect(freshChanges.every((c) => !c.breaking)).toBe(true);

    // Подмена итога в файле записи (ломающее → неломающее) ломает подпись: запись не читается.
    const file = join(red.store.root, 'records', red.id.slice(0, 2), `${red.id}.json`);
    const original = readFileSync(file);
    const forged = JSON.parse(original.toString('utf8')) as CheckRecord;
    if (forged.classOutcome?.class !== 'contract') throw new Error('contract outcome');
    for (const o of forged.classOutcome.value) for (const c of o.changes) c.breaking = false;
    writeFileSync(file, JSON.stringify(forged));
    expect(red.store.record(red.id)).toEqual({
      unknown: `check.records ${red.id}: bad signature`,
    });
    writeFileSync(file, original);
    expect('value' in red.store.record(red.id)).toBe(true);
    task.close();
  }, 120_000);

  const pgRuns = h !== undefined && pgImage !== undefined && !inContainer;
  if (!pgRuns)
    it.skip(`real postgres skipped: ${h ? 'no local postgres image' : 'no engine'}`, () =>
      undefined);
  it.runIf(pgRuns)(
    'migration: up and down on a scratch database of the task container; a down that does not revert the schema is red; no container is no verdict',
    async () => {
      const root = tempDir('cls-mig-');
      roots.push(root);
      const main = join(root, 'main');
      const copy = join(root, 'copy');
      mkdirSync(join(main, '.agentdeck'), { recursive: true });
      mkdirSync(join(main, 'db'), { recursive: true });
      writeFileSync(
        join(main, 'compose.yaml'),
        `services:\n  db:\n    image: ${pgImage}\n    ports:\n      - "5432:5432"\n    environment:\n      POSTGRES_DB: app\n      POSTGRES_PASSWORD: pw\n`,
      );
      writeFileSync(
        join(main, '.agentdeck', 'checks.json'),
        `${JSON.stringify({
          v: 1,
          checks: [
            {
              id: 'mig',
              class: 'migration',
              argv: ['migrate'],
              cwd: 'db',
              requiredAt: ['publish'],
              needs: [{ service: 'db' }],
            },
          ],
        })}\n`,
      );
      writeFileSync(
        join(main, 'db', '001_pets.up.sql'),
        'CREATE TABLE pets (id int primary key, name text);\n',
      );
      writeFileSync(join(main, 'db', '001_pets.down.sql'), 'DROP TABLE pets;\n');
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
          stdio: 'ignore',
        });
      execFileSync('git', ['init', '-q', '-b', 'main', main], { stdio: 'ignore' });
      git(main, 'add', '-A');
      git(main, 'commit', '-q', '-m', 'base');
      git(main, 'worktree', 'add', '-q', '-b', 'agentdeck/copy', copy);
      const { task } = await openFresh(join(root, 'tasks'));
      task.append({
        kind: 'task.created',
        actor: 'core',
        data: { ...CREATED, repos: [{ repoKey: 'r1', path: copy, baseRef: 'main' }] },
      });
      const b = bind(task);
      const real = servicesWiring({ registry: { live: () => task } as unknown as TaskRegistry });
      const svc = {
        stands: real.stands,
        ensureServices: (recipes: Parameters<typeof real.ensureServices>[0]) =>
          real.ensureServices(recipes, {
            start: { extraLabels: { [ZONE_LABEL]: ZONE_RUN }, readyTimeoutMs: 120_000 },
          }),
      };
      const w = queueWiring({
        registry: { live: () => task },
        layout: ensureCoreHome(join(root, 'home')),
        services: svc,
      });
      const check = async (): Promise<ModelCheckReply> => {
        let reply = (await w.check(task, b, { checkId: 'mig' })) as ModelCheckReply;
        for (let i = 0; i < 3 && reply.units[0]?.verdict === 'running'; i += 1)
          reply = (await w.check(task, b, { checkId: 'mig' })) as ModelCheckReply;
        return reply;
      };

      const green = await check();
      // Ответ целиком — в сообщение: «no-verdict» без причины не разобрать (g13 p10, полный прогон).
      expect(green.units, JSON.stringify(green)).toMatchObject([{ unit: '.', verdict: 'pass' }]);
      expect(logOf(green)).toMatch(/^applied: 001_pets\.up\.sql\ndown: reverted\n/);
      expect((await recordOf(w, copy, green)).rec.classOutcome).toMatchObject({
        class: 'migration',
        value: { applied: ['001_pets.up.sql'], down: 'reverted', failed: null },
      });

      writeFileSync(join(copy, 'db', '001_pets.down.sql'), 'SELECT 1;\n');
      const red = await check();
      expect(red.verdict, JSON.stringify(red)).toBe('fail');
      expect(logOf(red)).toMatch(/\ndown: differs\n/);
      const redRec = await recordOf(w, copy, red);
      expect(redRec.rec.classOutcome).toMatchObject({
        class: 'migration',
        value: { applied: ['001_pets.up.sql'], down: 'differs', failed: null },
      });
      // Подмена итога миграции (differs → reverted) ломает подпись, как подмена вердикта.
      const recFile = join(
        redRec.store.root,
        'records',
        redRec.id.slice(0, 2),
        `${redRec.id}.json`,
      );
      const was = readFileSync(recFile);
      const forged = JSON.parse(was.toString('utf8')) as CheckRecord;
      if (forged.classOutcome?.class !== 'migration') throw new Error('migration outcome');
      forged.classOutcome.value.down = 'reverted';
      writeFileSync(recFile, JSON.stringify(forged));
      expect(redRec.store.record(redRec.id)).toEqual({
        unknown: `check.records ${redRec.id}: bad signature`,
      });
      writeFileSync(recFile, was);

      const released = await releaseServices(task);
      expect(released).toMatchObject([{ verified: expect.stringMatching(/absent$/) }]);
      // Контейнера задачи нет (очередь подняла бы его снова — здесь исполнитель зовётся мимо неё):
      // у миграции нет базы — без вердикта, никогда не зелёный.
      const parts = await w.parts();
      if (!('value' in parts)) throw new Error('parts');
      const reg = await parts.value.deps.registry({
        taskId: task.taskId,
        project: 'r1',
        copyDir: copy,
      } as never);
      const entry = 'value' in reg ? reg.value.checks.find((c) => c.id === 'mig') : undefined;
      expect(entry?.class).toBe('migration');
      const gone = await classRun({ baseOf: () => null, recipes: async () => [] })(
        {
          checkRunId: newId(),
          taskId: task.taskId,
          entry: entry!,
          argv: entry!.argv,
          cwd: join(copy, 'db'),
          env: {},
          tempRoot: root,
          deadlineMs: 60_000,
        },
        { leaseId: 'l', beatMs: 1_000, heartbeat: () => 'ok' },
        { now: Date.now, standEpoch: () => null },
      );
      expect(gone).toMatchObject({
        end: 'spawn-failed',
        exit: null,
        reason: 'migration: no running db container of the task',
      });
      task.close();
    },
    300_000,
  );
});
