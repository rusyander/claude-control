import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  ContractOutcome,
  MigrationOutcome,
  ServiceRecipe,
} from '@agentdeck/contracts/core/records';
import { join } from 'node:path';
import { notRun } from '../../conductor/checks/request/helpers.ts';
import { EPHEMERAL_LABEL, execIn, listByLabels } from '../../platform/container-engine/ops.ts';
import { engineHandle } from '../../platform/container-engine/probe.ts';
import type { EngineHandle } from '../../platform/container-engine.types.ts';
import { listFilesUnder, readCopyText } from '../../platform/copy-fs.ts';
import { git } from '../../platform/git.ts';
import { runContract } from '../../verifier/classes/contract.ts';
import { migrationPlan, postgresIo, runMigrations } from '../../verifier/classes/migration.ts';
import { runCheck } from '../../verifier/run/run.ts';
import type { RunDeps, RunLease, RunResult, RunSpec } from '../../verifier/run/run.types.ts';
import { serviceLabels } from '../../verifier/services/index.ts';

/**
 * Исполнитель прогона по классу проверки (F-071/F-113, 04:128-131): `migration` и `contract` —
 * не процесс раннера, а свои исполнители зоны F; остальные классы — `runCheck`. Один вход для
 * очереди, итога и «красного до» (`CheckDeps.run`), поэтому аренда, срок и запись — те же.
 *
 * `migration`: файлы `*.sql` в `cwd` записи (каталог миграций), по порядку версий; база — ЧИСТАЯ
 * одноразовая БД внутри контейнера задачи первого сервиса из `needs` (`CREATE DATABASE`, снимается
 * после): up, сверка схемы, down и сверка с исходной. Красный — упавший файл или схема после down
 * не вернулась. Контейнер не найден или движка нет — без вердикта (`env`), никогда не зелёный (P58).
 *
 * `contract`: argv записи — файлы схем от `cwd`; «до» — тот же файл на закреплённой базе задачи
 * (`git show <base>:./<file>`), «после» — в копии. Красный — ломающее изменение. Генератор клиента
 * не гоняется (drift `null`, назван в выводе): у профиля пока нет поля генератора.
 *
 * Итог обоих — `RunResult.classOutcome`, запись кладёт его под подпись (`CheckRecord.classOutcome`);
 * лог — только текст для человека, машинного итога в нём нет.
 */

export interface ClassRunDeps {
  /** База копии прогона (`cwd` внутри неё); `null` — не известна, контракт без вердикта. */
  baseOf(spec: RunSpec): string | null;
  recipes(taskId: string): Promise<readonly ServiceRecipe[]>;
  engine?: () => Promise<Fact<EngineHandle>>;
  run?: (spec: RunSpec, lease: RunLease, deps: RunDeps) => Promise<RunResult>;
}

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

async function done(
  spec: RunSpec,
  deps: RunDeps,
  started: number,
  exit: 0 | 1,
  log: string,
  classOutcome: NonNullable<RunResult['classOutcome']>,
): Promise<RunResult> {
  const epoch = await deps.standEpoch(spec.taskId);
  return {
    classOutcome,
    end: 'exit',
    exit,
    signal: null,
    ms: deps.now() - started,
    log,
    logBytes: Buffer.byteLength(log),
    truncated: false,
    failing: [],
    standEpoch: epoch,
    standMoved: false,
    temp: { removed: true },
  };
}

/** Красный миграции: упал файл или down не вернул схему; разрушающие выражения только названы. */
export function migrationRed(o: MigrationOutcome): boolean {
  return o.failed !== null || o.down === 'differs';
}

export function migrationLog(o: MigrationOutcome): string {
  return [
    `applied: ${o.applied.length ? o.applied.join(', ') : '(none)'}`,
    `down: ${o.down}`,
    `schema: +${o.schemaDiff.added.length} -${o.schemaDiff.removed.length}`,
    ...o.schemaDiff.added.map((l) => `+ ${l}`),
    ...o.schemaDiff.removed.map((l) => `- ${l}`),
    ...o.findings.map((f) => `destructive ${f.kind} in ${f.file}: ${f.statement}`),
    ...(o.failed ? [`FAILED ${o.failed.file}:`, o.failed.tail] : []),
  ].join('\n');
}

export function contractRed(outcomes: readonly ContractOutcome[]): boolean {
  return outcomes.some((o) => o.changes.some((c) => c.breaking));
}

export function contractLog(outcomes: readonly ContractOutcome[]): string {
  return outcomes
    .flatMap((o) => [
      `${o.file} (${o.format}): ${o.changes.length} change(s)`,
      ...o.changes.map((c) => `${c.breaking ? 'BREAKING' : 'ok'} ${c.kind} ${c.at}: ${c.detail}`),
      `generated drift: ${o.generatedDrift === null ? 'no generator in the profile' : o.generatedDrift.join(', ') || 'none'}`,
    ])
    .join('\n');
}

async function migration(spec: RunSpec, run: RunDeps, deps: ClassRunDeps): Promise<RunResult> {
  const started = run.now();
  const need = spec.entry.needs[0];
  if (!need) return notRun('migration: the check names no database service in `needs`');
  const files = listFilesUnder(spec.cwd, '', new Set())
    .filter((f) => !f.includes('/') && f.toLowerCase().endsWith('.sql'))
    .map((f) => ({ path: f, text: readCopyText(join(spec.cwd, f)) }));
  const unread = files.filter((f) => f.text === undefined).map((f) => f.path);
  if (unread.length > 0) return notRun(`migration: unreadable ${unread.join(', ')}`);
  const steps = migrationPlan(files as { path: string; text: string }[]);
  const engine = await (deps.engine ?? (() => engineHandle()))();
  if (!('value' in engine)) return notRun(`migration: container engine: ${why(engine)}`);
  const h = engine.value;
  const rows = await listByLabels(h, {
    ...serviceLabels(spec.taskId, need.service),
    [EPHEMERAL_LABEL]: '1',
  });
  const box = 'value' in rows ? rows.value.find((r) => r.state === 'running') : undefined;
  if (!box) return notRun(`migration: no running ${need.service} container of the task`);
  const recipe = (await deps.recipes(spec.taskId)).find((r) => r.name === need.service);
  const user = recipe?.env.POSTGRES_USER ?? 'postgres';
  const home = recipe?.env.POSTGRES_DB ?? user;
  // Имя чистой БД — из номера прогона: только буквы, цифры и `_`, кавычек не нужно.
  const scratch = `agentdeck_mig_${spec.checkRunId
    .replace(/[^a-z0-9]/gi, '')
    .slice(-20)
    .toLowerCase()}`;
  const psql = (sql: string) =>
    execIn(h, box.id, ['psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', user, '-d', home, '-c', sql], {
      timeoutMs: 60_000,
    });
  const made = await psql(`CREATE DATABASE ${scratch}`);
  if ('error' in made || made.code !== 0)
    return notRun(
      `migration: scratch database: ${'error' in made ? made.error : made.stderr.trim()}`,
    );
  try {
    const outcome = await runMigrations(steps, postgresIo(h, box.id, { user, db: scratch }));
    if (!('value' in outcome)) return notRun(`migration: ${why(outcome)}`);
    return await done(
      spec,
      run,
      started,
      migrationRed(outcome.value) ? 1 : 0,
      migrationLog(outcome.value),
      { class: 'migration', value: outcome.value },
    );
  } finally {
    await psql(`DROP DATABASE IF EXISTS ${scratch}`);
  }
}

async function contract(spec: RunSpec, run: RunDeps, deps: ClassRunDeps): Promise<RunResult> {
  const started = run.now();
  const base = deps.baseOf(spec);
  if (base === null) return notRun('contract: the pinned base of the copy is unknown');
  if (spec.argv.length === 0) return notRun('contract: the check names no schema file in argv');
  const outcomes: ContractOutcome[] = [];
  for (const file of spec.argv) {
    const after = readCopyText(join(spec.cwd, file));
    if (after === undefined) return notRun(`contract: ${file} is unreadable in the copy`);
    const shown = await git(spec.cwd, ['show', `${base}:./${file.replace(/\\/g, '/')}`], {
      timeoutMs: 30_000,
      acceptNonZero: true,
    }).catch((error: unknown) => ({ code: null, stdout: '', error }));
    // Файла нет на базе — контракт новый, всё «добавлено» (`before: null`).
    const before = shown.code === 0 ? shown.stdout : null;
    if (shown.code === null) return notRun(`contract: git show ${file} at ${base} did not run`);
    const got = await runContract({ file, before, after });
    if (!('value' in got)) return notRun(`contract: ${why(got)}`);
    outcomes.push(got.value);
  }
  return done(spec, run, started, contractRed(outcomes) ? 1 : 0, contractLog(outcomes), {
    class: 'contract',
    value: outcomes,
  });
}

const OWN: Partial<
  Record<string, (spec: RunSpec, run: RunDeps, deps: ClassRunDeps) => Promise<RunResult>>
> = { migration, contract };

export function classRun(
  deps: ClassRunDeps,
): (spec: RunSpec, lease: RunLease, run: RunDeps) => Promise<RunResult> {
  const fallback = deps.run ?? runCheck;
  return async (spec, lease, run) => {
    const own = OWN[spec.entry.class];
    if (!own) return fallback(spec, lease, run);
    // Аренда живёт ударами сердца, как у процесса раннера: долгая миграция без них потеряла бы слот.
    const beat = setInterval(() => lease.heartbeat(), Math.max(1_000, lease.beatMs));
    try {
      return await own(spec, run, deps);
    } finally {
      clearInterval(beat);
    }
  };
}
