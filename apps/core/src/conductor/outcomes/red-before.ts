import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckEntry,
  CheckRegistry,
  CheckRequest,
  RedBeforeResult,
} from '@agentdeck/contracts/core/records';
import { join } from 'node:path';
import { fileExists } from '../../platform/copy-fs.ts';
import { diffUnit } from '../../platform/git.ts';
import { isCodePath, isCoverageSource } from '../../verifier/compose/coverage.ts';
import { covers } from '../../verifier/key/index.ts';
import { proveRedBefore } from '../../verifier/red/prove.ts';
import { argvFor } from '../../verifier/run/argv.ts';
import { withBaseTree } from './base-tree.ts';
import { leasedRun } from './leased-run.ts';
import type { OutcomeDeps, RedBeforeInput, RedBeforeDecision } from './outcomes.types.ts';

/**
 * «Красный до» после шага работы над багом (04:68-71, P94, F-107): тесты фикса — те, что лежат в
 * изменённых файлах тестов и прошли на итоге копии (узкий прогон раннера сценария); каждый
 * гоняется на закреплённой базе (дерево рядом, файл теста перенесён) и на копии — две подписанные
 * записи, решение `decideRedBefore` (через `proveRedBefore`, один судья). Прогоны — под арендой
 * слота той же очереди. Неизвестное (реестр, дифф, имя теста) — `unknown` с причиной, не «не доказано».
 */

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');
const slash = (p: string): string => {
  const forward = p.split('\\').join('/');
  return forward.startsWith('./') ? forward.slice(2) : forward;
};

/** Файл теста — код, который не «исходник» для покрытия (тот же разбор, что у итога). */
export function isTestFile(path: string): boolean {
  return isCodePath(path) && !isCoverageSource(path);
}

/** Единица реестра, чьи пути покрывают файл; раннер проекта — вся копия `.`. */
export function unitOfFile(
  registry: CheckRegistry,
  entry: CheckEntry,
  file: string,
): { unit: string; unitDir?: string } {
  if (entry.unit !== 'package') return { unit: '.' };
  for (const [unit, def] of Object.entries(registry.units).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const own = def.paths.find((p) => covers(p, file));
    if (own !== undefined) return { unit, unitDir: def.paths[0] ?? own };
  }
  return { unit: '.' };
}

/**
 * Имя прошедшего теста против файлов фикса: раннер пишет путь от своего cwd (корень или каталог
 * единицы) — совпадение по хвосту пути от корня репозитория.
 */
export function fixTests(
  passing: readonly { file?: string; name: string }[],
  files: readonly string[],
): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const p of passing) {
    if (!p.file) continue;
    const tail = slash(p.file);
    const file = files.find((f) => f === tail || f.endsWith(`/${tail}`));
    if (!file || seen.has(`${file}\0${p.name}`)) continue;
    seen.add(`${file}\0${p.name}`);
    out.push({ file, name: p.name });
  }
  return out;
}

function requestOf(input: RedBeforeInput, copyDir: string, unit: string): CheckRequest {
  return {
    road: 'conductor',
    origin: 'core',
    taskId: input.taskId,
    stepId: input.stepId,
    project: input.project,
    copyDir,
    class: 'work',
    phase: 'mid-task',
    checkId: input.checkId,
    unit,
    changedUnits: [],
    exec: 'core',
  };
}

export async function redBeforeOf(
  input: RedBeforeInput,
  deps: OutcomeDeps,
): Promise<Fact<RedBeforeDecision>> {
  const c = deps.checks;
  const req = requestOf(input, input.copyDir, '.');
  const registry = await c.registry(req);
  if (!('value' in registry)) return { unknown: `registry: ${why(registry)}` };
  const entry = registry.value.checks.find((e) => e.id === input.checkId);
  if (!entry) return { unknown: `regression check ${input.checkId} is not in the registry` };
  if (entry.class !== 'test-runner' || !entry.filter)
    return {
      unknown: `${input.checkId}: not a test runner with a narrow filter — no test to name`,
    };
  const changed = await diffUnit(input.copyDir, input.baseRef);
  if (!('value' in changed)) return { unknown: `diff against ${input.baseRef}: ${why(changed)}` };
  const files = changed.value.filter(isTestFile).filter((f) => fileExists(join(input.copyDir, f)));
  const store = c.store(req);
  if (!('value' in store)) return { unknown: `store: ${why(store)}` };
  const env = await c.env(req);
  if (!('value' in env)) return { unknown: `env: ${why(env)}` };
  const out: RedBeforeDecision = {
    checkId: input.checkId,
    tests: [],
    results: [],
    unknown: [],
    proven: false,
  };
  if (files.length === 0) return { value: out };
  const deadlineMs = input.deadlineMs ?? 10 * 60_000;
  const run = leasedRun({
    queue: c.queue,
    class: 'work',
    project: input.project,
    taskId: input.taskId,
    runDeps: { now: c.now, standEpoch: c.standEpoch },
    ...(c.run ? { run: c.run } : {}),
    now: c.now,
  });

  // Тесты фикса — по единицам: раннер пакета гоняется из каталога своей единицы.
  const byUnit = new Map<string, { unitDir?: string; files: string[] }>();
  for (const file of files) {
    const at = unitOfFile(registry.value, entry, file);
    const group = byUnit.get(at.unit) ?? {
      ...(at.unitDir === undefined ? {} : { unitDir: at.unitDir }),
      files: [],
    };
    group.files.push(file);
    byUnit.set(at.unit, group);
  }
  const candidates: { file: string; name: string; unit: string; unitDir?: string }[] = [];
  for (const [unit, group] of byUnit) {
    const { argv } = argvFor(entry, {
      unit,
      selection: [],
      base: null,
      files: group.files,
      ...(group.unitDir === undefined ? {} : { unitDir: group.unitDir }),
    });
    const result = await run({
      checkRunId: c.newId(),
      taskId: input.taskId,
      entry,
      argv,
      cwd: entry.cwd === '' ? input.copyDir : join(input.copyDir, entry.cwd),
      env: env.value,
      tempRoot: c.tempRoot,
      deadlineMs,
    });
    if (result.end !== 'exit') {
      out.unknown.push({
        test: group.files.join(', '),
        why: `run ended ${result.end}${result.reason ? `: ${result.reason}` : ''}`,
      });
      continue;
    }
    const named = fixTests(result.passing ?? [], group.files);
    if (named.length === 0)
      out.unknown.push({
        test: group.files.join(', '),
        why: 'the runner output names no passing test in the fix test files',
      });
    for (const t of named)
      candidates.push({
        ...t,
        unit,
        ...(group.unitDir === undefined ? {} : { unitDir: group.unitDir }),
      });
  }
  const picked = candidates.slice(0, input.cap ?? 5);
  out.tests = picked.map(({ file, name }) => ({ file, name }));
  if (picked.length === 0) return { value: out };

  const envRoots = ['', ...Object.values(registry.value.units).map((u) => u.paths[0] ?? '')];
  const proved = await withBaseTree(
    {
      copyDir: input.copyDir,
      baseRef: input.baseRef,
      dir: join(c.tempRoot, `base-${c.newId()}`),
      carry: files,
      envRoots,
    },
    async (baseDir): Promise<Fact<RedBeforeResult[]>> => {
      // Окружение одно на обе стороны: PATH копии (`node_modules/.bin`) — через ссылку и у базы.
      const results: RedBeforeResult[] = [];
      for (const t of picked) {
        const keyIn = { entry, registry: registry.value, unit: t.unit, selection: [t.name] };
        const [finalKey, baseKey] = await Promise.all([
          c.key({ ...keyIn, req: requestOf(input, input.copyDir, t.unit) }),
          c.key({ ...keyIn, req: requestOf(input, baseDir, t.unit) }),
        ]);
        if (!('value' in finalKey) || !('value' in baseKey)) {
          out.unknown.push({
            test: t.name,
            why: `key: ${'value' in finalKey ? `base ${why(baseKey)}` : why(finalKey)}`,
          });
          continue;
        }
        const got = await proveRedBefore(
          {
            test: { file: t.file, name: t.name },
            entry,
            unit: t.unit,
            ...(t.unitDir === undefined ? {} : { unitDir: t.unitDir }),
            base: { dir: baseDir, ...baseKey.value },
            final: { dir: input.copyDir, ...finalKey.value },
            taskId: input.taskId,
            env: env.value,
            tempRoot: c.tempRoot,
            deadlineMs,
          },
          { run, store: store.value, now: c.now, newId: c.newId },
        );
        if ('value' in got) results.push(got.value);
        else out.unknown.push({ test: t.name, why: why(got) });
      }
      return { value: results };
    },
  );
  if (!('value' in proved)) return { unknown: `red-before on base: ${why(proved)}` };
  out.results = proved.value;
  out.proven = proved.value.some((r) => r.outcome === 'proven');
  return { value: out };
}
