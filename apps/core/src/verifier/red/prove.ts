import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckEntry,
  CheckKey,
  CheckRecord,
  KeyParts,
  RecordId,
  RedBeforeResult,
} from '@agentdeck/contracts/core/records';
import { join } from 'node:path';
import { argvFor } from '../run/argv.ts';
import type { RunResult, RunSpec } from '../run/run.types.ts';
import { narrowVerdict, verdictOf } from '../run/verdict.ts';
import type { RecordDraft } from '../store/store.types.ts';
import { decideRedBefore } from './red-before.ts';

/**
 * «Красный до» на раннере ядра (04:68-71, R:S2-14, P94): названный регрессионный тест гоняется
 * узким прогоном на содержимом базы (папка базы уже несёт файл теста из финала) и на финальном
 * содержимом; обе записи ложатся в хранилище, решение — `decideRedBefore` по этим записям (один
 * судья, P01). Сюда приходит только сборка прогона и записи; аренда, окружение и ключ — от
 * вызывающего (очередь, профиль, ключ зоны A), так что путь тот же, что у любой проверки.
 */

export interface ProveSide {
  /** Абсолютная папка содержимого (копия базы с файлом теста / финальная копия). */
  dir: string;
  key: CheckKey;
  parts: KeyParts;
}

export interface ProveInput {
  test: { file: string; name: string };
  entry: CheckEntry;
  unit: string;
  /** Каталог единицы от корня репо — у члена воркспейса файл теста переводится от него. */
  unitDir?: string;
  base: ProveSide;
  final: ProveSide;
  taskId: string | null;
  env: Record<string, string>;
  tempRoot: string;
  deadlineMs: number;
}

export interface ProveDeps {
  /** Прогон под арендой слота (`runCheck` зоны C с арендой, выданной очередью). */
  run(spec: RunSpec): Promise<RunResult>;
  store: {
    write(draft: RecordDraft, log: string): Fact<RecordId>;
    record(id: RecordId): Fact<CheckRecord>;
  };
  now(): number;
  newId(): string;
}

async function runSide(
  input: ProveInput,
  side: ProveSide,
  grade: 'base' | 'narrow',
  deps: ProveDeps,
): Promise<Fact<CheckRecord>> {
  const { argv, narrowed } = argvFor(input.entry, {
    unit: input.unit,
    selection: [input.test.name],
    base: null,
    files: [input.test.file],
    ...(input.unitDir === undefined ? {} : { unitDir: input.unitDir }),
  });
  const checkRunId = deps.newId();
  const startedAt = deps.now();
  const kind = input.entry.filter?.kind;
  const result = await deps.run({
    checkRunId,
    taskId: input.taskId ?? checkRunId,
    entry: input.entry,
    argv,
    cwd: input.entry.cwd === '' ? side.dir : join(side.dir, input.entry.cwd),
    env: input.env,
    tempRoot: input.tempRoot,
    deadlineMs: input.deadlineMs,
  });
  const written = deps.store.write(
    {
      key: side.key,
      parts: side.parts,
      checkId: input.entry.id,
      unit: input.unit,
      grade,
      origin: 'core',
      // Узкий зелёный без единого выполненного теста — не зелёный: иначе ворота сказали бы
      // «тест бага не ловит» по выборке, не совпавшей ни с чем.
      verdict: narrowVerdict(verdictOf(result), narrowed && kind ? { kind, log: result.log } : null)
        .verdict,
      exit: result.exit,
      ms: result.ms,
      startedAt,
      argv,
      failing: result.failing,
      ...(result.passing ? { passing: result.passing } : {}),
      retries: [],
      artifacts: null,
      envPrepared: true,
      standEpoch: result.standEpoch,
      taskId: input.taskId,
      checkRunId,
      ...(result.classOutcome ? { classOutcome: result.classOutcome } : {}),
    },
    result.log,
  );
  if (!('value' in written)) return written;
  return deps.store.record(written.value);
}

/** Факт решения: запись не легла или не перечиталась — `unknown`, ворота не решены (P44). */
export async function proveRedBefore(
  input: ProveInput,
  deps: ProveDeps,
): Promise<Fact<RedBeforeResult>> {
  if (input.entry.class !== 'test-runner' || !input.entry.filter)
    return { unknown: `${input.entry.id}: не раннер тестов с узким фильтром — тест не назвать` };
  const base = await runSide(input, input.base, 'base', deps);
  if (!('value' in base)) return 'unknown' in base ? base : { unknown: 'запись базы пропала' };
  const final = await runSide(input, input.final, 'narrow', deps);
  if (!('value' in final)) return 'unknown' in final ? final : { unknown: 'запись финала пропала' };
  return { value: decideRedBefore(input.test.name, base.value, final.value, input.test.file) };
}
