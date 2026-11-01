import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckEntry,
  CheckKey,
  CheckRecord,
  CheckRegistry,
  CheckRequest,
  ComposeDecision,
  CompositionKey,
  QuarantineEntry,
} from '@agentdeck/contracts/core/records';
import { join } from 'node:path';
import { changedPaths, treeRows } from '../../platform/git.ts';
import { readCaseCodePaths, type CaseCodePaths } from '../../platform/tests-store.ts';
import { coverageMap, coveredFact } from '../../publisher/case-coverage/index.ts';
import { compose } from '../../verifier/compose/index.ts';
import { sha256 } from '../../verifier/key/index.ts';
import { argvFor } from '../../verifier/run/argv.ts';
import { verdictOf } from '../../verifier/run/verdict.ts';
import type { RecordStore } from '../../verifier/store/index.ts';
import { sleep } from '../checks/request/helpers.ts';
import { changedUnitsOf } from '../checks/scope.ts';
import { withBaseTree } from './base-tree.ts';
import { leasedRun } from './leased-run.ts';
import type { FinalGateInput, FinalGateOutcome, OutcomeDeps } from './outcomes.types.ts';

/**
 * Итог на финальной проверке единицы (04:56-59, 04:78-86, F-037/F-041): `compose` — единственный
 * судья (P01), здесь только его входы и исполнение его «прогнать». Ключи — тем же `key` очереди
 * для каждой обязательной пары; записи — из хранилища по ключу; недостающее (`unit`/`retry`) —
 * через вход проверки (`requestCheck`, дорога `conductor`, фаза `final`), разряд `base` — на дереве
 * закреплённой базы под арендой слота, запись своего сорта. Решение снова — до трёх раундов; второй
 * итог на том же дереве переигрывает записи и не гоняет ничего (04:57, ранние прогоны простоя).
 */

const WHOLE = '.';
const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');
const pairId = (checkId: string, unit: string): string => `${checkId}\0${unit}`;

/** Отпечаток дерева итога: строки `mode blob\tpath` по порядку пути (форма рабочего дерева). */
export function treeFp(rows: readonly { path: string; mode: string; blob: string }[]): string {
  const lines = rows.map((r) => `${r.mode} ${r.blob}\t${r.path}`).sort();
  return sha256(lines.join('\n'));
}

/** Пары, которые итог может потребовать: проверки к публикации/сдаче × единицы (пакет) или `.`. */
export function gatePairs(registry: CheckRegistry): { entry: CheckEntry; unit: string }[] {
  const out: { entry: CheckEntry; unit: string }[] = [];
  for (const entry of registry.checks) {
    if (!entry.requiredAt.some((at) => at === 'publish' || at === 'deliver')) continue;
    if (entry.unit !== 'package') out.push({ entry, unit: WHOLE });
    else for (const unit of Object.keys(registry.units).sort()) out.push({ entry, unit });
  }
  return out;
}

function request(
  input: FinalGateInput,
  copyDir: string,
  checkId: string,
  unit: string,
  changedUnits: string[],
): CheckRequest {
  return {
    road: 'conductor',
    origin: 'core',
    taskId: input.taskId,
    stepId: input.stepId,
    project: input.project,
    copyDir,
    class: 'deliver',
    phase: 'final',
    checkId,
    unit,
    changedUnits,
    exec: 'core',
  };
}

export async function finalGate(
  input: FinalGateInput,
  deps: OutcomeDeps,
): Promise<Fact<FinalGateOutcome>> {
  const c = deps.checks;
  const compositionId = c.newId();
  const since = c.now();
  const probe = request(input, input.copyDir, '', WHOLE, []);
  const store = c.store(probe);
  if (!('value' in store)) return { unknown: `store: ${why(store)}` };
  const cases: Fact<CaseCodePaths[]> = input.sourceRepo
    ? readCaseCodePaths(input.sourceRepo)
    : { unknown: 'source repository of the unit not given' };
  let lastChanged: string[] = [];
  const quarantine: QuarantineEntry[] = (() => {
    const q = c.quarantine?.(probe);
    return q && 'value' in q ? q.value : [];
  })();
  const baseKeys = new Map<string, Fact<CheckKey>>();
  const ran: FinalGateOutcome['ran'] = [];
  const rounds = input.rounds ?? 3;
  let decision: ComposeDecision | null = null;
  let round = 0;
  for (; round < rounds; round += 1) {
    const registry = await c.registry(probe);
    if (!('value' in registry))
      return {
        value: {
          compositionId,
          rounds: round,
          ran,
          units: [],
          decision: {
            kind: 'refuse',
            unmet: [{ code: 'registry-unreadable', subject: input.project, next: why(registry) }],
            next: 'registry of the copy is unreadable: fix the profile and gate again',
          },
        },
      };
    const [rows, baseRows] = await Promise.all([
      treeRows(input.copyDir, 'worktree'),
      treeRows(input.copyDir, input.baseRef),
    ]);
    if (!('value' in rows)) return { unknown: `work tree: ${why(rows)}` };
    if (!('value' in baseRows)) return { unknown: `base ${input.baseRef}: ${why(baseRows)}` };
    const changed = changedPaths(rows.value, baseRows.value);
    lastChanged = changed;
    const changedUnits = changedUnitsOf(registry.value, rows.value, baseRows.value);
    const pairs = gatePairs(registry.value);
    const keys: CompositionKey[] = [];
    const records: Record<CheckKey, CheckRecord[]> = {};
    for (const { entry, unit } of pairs) {
      const key = await c.key({
        req: request(input, input.copyDir, entry.id, unit, changedUnits),
        entry,
        registry: registry.value,
        unit,
        selection: [],
      });
      const baseKey = baseKeys.get(pairId(entry.id, unit)) ?? null;
      keys.push({
        checkId: entry.id,
        unit,
        key: 'value' in key ? { value: key.value.key } : key,
        baseKey,
      });
      for (const k of [
        'value' in key ? key.value.key : null,
        baseKey && 'value' in baseKey ? baseKey.value : null,
      ]) {
        if (!k || records[k]) continue;
        const scan = store.value.scan(k);
        records[k] = 'value' in scan ? scan.value.records : [];
      }
    }
    decision = compose({
      repo: input.project,
      tree: treeFp(rows.value),
      base: input.baseRef,
      registry: registry.value,
      changed,
      records,
      quarantine,
      coverage: input.coverage ?? 'warn',
      compositionId,
      keys,
      // Связь «файл ↔ кейс» — из блока тестов исходного репозитория; его нет — неизвестно, и
      // каждый изменённый исходник назван пробелом (при `warn` это не отказ).
      covered: coveredFact(changed, cases, input.project),
      scenarioRequired: input.scenarioRequired ?? [],
      since,
    });
    if (decision.kind !== 'run') break;
    const wanted = decision.units;
    const base = wanted.filter((u) => u.grade === 'base');
    for (const u of wanted.filter((w) => w.grade !== 'base')) {
      const outcome = await ask(
        deps,
        request(input, input.copyDir, u.checkId, u.unit, changedUnits),
      );
      ran.push({ round, checkId: u.checkId, unit: u.unit, grade: u.grade, outcome });
    }
    if (base.length > 0) {
      const done = await runOnBase(input, deps, registry.value, base, baseKeys, store.value);
      for (const r of done) ran.push({ round, ...r });
    }
  }
  if (!decision) return { unknown: 'final gate made no decision' };
  if (decision.kind === 'run')
    decision = {
      kind: 'refuse',
      unmet: decision.units.map((u) => ({
        code: 'record-missing' as const,
        subject: `${u.checkId}:${u.unit} (${u.grade})`,
        next: 'the run gave no composable record',
      })),
      next: `still missing records after ${rounds} rounds: see the runs of this gate`,
    };
  return {
    value: {
      compositionId,
      decision,
      rounds: round,
      ran,
      units: decision.kind === 'ready' ? decision.units : [],
      coverage: coverageMap(lastChanged, cases, input.project),
    },
  };
}

/** Вход проверки до ответа с записью: `running` — переспросить (P68, присоединение к прогону). */
async function ask(deps: OutcomeDeps, req: CheckRequest): Promise<string> {
  const until = deps.checks.now() + (deps.waitMs ?? 30 * 60_000);
  for (;;) {
    const answer = await deps.service.requestCheck(req);
    if (answer.kind === 'running' && deps.checks.now() < until) {
      await sleep(deps.pollMs ?? 500);
      continue;
    }
    if (answer.kind === 'refuse') return `refuse: ${answer.unmet.map((u) => u.code).join(', ')}`;
    if (answer.kind === 'defer') return `defer: ${answer.reason}`;
    return answer.kind;
  }
}

async function runOnBase(
  input: FinalGateInput,
  deps: OutcomeDeps,
  registry: CheckRegistry,
  wanted: { checkId: string; unit: string }[],
  baseKeys: Map<string, Fact<CheckKey>>,
  store: Pick<RecordStore, 'write'>,
): Promise<{ checkId: string; unit: string; grade: string; outcome: string }[]> {
  const c = deps.checks;
  const out: { checkId: string; unit: string; grade: string; outcome: string }[] = [];
  const env = await c.env(request(input, input.copyDir, '', WHOLE, []));
  const run = leasedRun({
    queue: c.queue,
    class: 'deliver',
    project: input.project,
    taskId: input.taskId,
    runDeps: { now: c.now, standEpoch: c.standEpoch },
    ...(c.run ? { run: c.run } : {}),
    now: c.now,
  });
  const done = await withBaseTree(
    {
      copyDir: input.copyDir,
      baseRef: input.baseRef,
      dir: join(c.tempRoot, `base-${c.newId()}`),
      carry: [],
      envRoots: ['', ...Object.values(registry.units).map((u) => u.paths[0] ?? '')],
    },
    async (baseDir): Promise<Fact<true>> => {
      for (const w of wanted) {
        const entry = registry.checks.find((e) => e.id === w.checkId);
        if (!entry || !('value' in env)) {
          out.push({
            ...w,
            grade: 'base',
            outcome: entry ? `env: ${why(env)}` : 'not in registry',
          });
          continue;
        }
        const key = await c.key({
          req: request(input, baseDir, w.checkId, w.unit, []),
          entry,
          registry,
          unit: w.unit,
          selection: [],
        });
        baseKeys.set(pairId(w.checkId, w.unit), 'value' in key ? { value: key.value.key } : key);
        if (!('value' in key)) {
          out.push({ ...w, grade: 'base', outcome: `key: ${why(key)}` });
          continue;
        }
        const unitDir = w.unit === WHOLE ? undefined : registry.units[w.unit]?.paths[0];
        const { argv } = argvFor(entry, {
          unit: w.unit,
          selection: [],
          base: null,
          files: [],
          ...(unitDir === undefined ? {} : { unitDir }),
        });
        const checkRunId = c.newId();
        const startedAt = c.now();
        const result = await run({
          checkRunId,
          taskId: input.taskId,
          entry,
          argv,
          cwd: entry.cwd === '' ? baseDir : join(baseDir, entry.cwd),
          env: env.value,
          tempRoot: c.tempRoot,
          deadlineMs: 30 * 60_000,
        });
        const verdict = verdictOf(result);
        const written = store.write(
          {
            key: key.value.key,
            parts: key.value.parts,
            checkId: entry.id,
            unit: w.unit,
            grade: 'base',
            origin: 'core',
            verdict,
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
        out.push({
          ...w,
          grade: 'base',
          outcome: 'value' in written ? verdict.kind : `record: ${why(written)}`,
        });
      }
      return { value: true };
    },
  );
  if (!('value' in done))
    for (const w of wanted) out.push({ ...w, grade: 'base', outcome: `base tree: ${why(done)}` });
  return out;
}
