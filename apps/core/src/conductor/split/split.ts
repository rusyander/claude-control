import { resolve } from 'node:path';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import { nextState, TASK_MACHINE } from '@agentdeck/contracts/core/states';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { samePath } from '../../platform/paths.ts';
import type { SplitEnv } from '../estimate/estimate.types.ts';
import { closeLaunchAsks } from '../human/launch-ask.ts';
import { journalPreflight, publishesOf, runTaskPreflight } from '../estimate/preflight-run.ts';
import { resolveScenario, scenarioPrecedence } from '../scenario/index.ts';
import { decideSplit, type SplitCheckDecision, type SplitUnit } from '../split-check/index.ts';
import { unitsOfSplit } from '../units/index.ts';
import { latestSplit, linesOf, type SplitRecordView } from './journal-view.ts';
import type {
  AfterAccept,
  ProposalSource,
  ProposedUnit,
  SplitFlowInput,
  SplitOutcome,
} from './split.types.ts';

/**
 * Деление (02 §Split, P39, P95, G6): предложение → проверка → решение, каждое строкой журнала, и
 * ни одной единицы деления до `split.decided`. Принятое переводит оценку в «ждёт запуска», дальше
 * политика (G16): `auto` — запуск сразу, `confirm` — точка 10 человеку. Запуск — предпроверка ещё
 * раз (P101: дорога могла упасть, пока человек читал), затем единица 0 закрыта и созданы единицы
 * деления в порядке проверки; соло — единица 0 и есть единица задачи.
 */

type TaskRepo = { repoKey: string; path: string };

/** Репозиторий единицы: ключ или путь задачи; не назван — единственный репозиторий. */
export function repoKeyFor(repo: string | null | undefined, repos: readonly TaskRepo[]): string {
  if (repo === null || repo === undefined) {
    return repos.length === 1 ? (repos[0] as TaskRepo).repoKey : '(not named)';
  }
  // Один каталог разными строками (короткое имя 8.3 `RUSYAN~1`, регистр, ссылка): путь задачи
  // приколот раскрытым, модель пишет его как видит — сравнение по ключу пути платформы (P52).
  const hit = repos.find((r) => r.repoKey === repo || samePath(r.path, resolve(repo)));
  return hit ? hit.repoKey : repo;
}

/** Единицы `step_done` → форма журнала. */
export function proposedOfClaim(
  units: NonNullable<StepDoneCall['units']>,
  repos: readonly TaskRepo[],
): ProposedUnit[] {
  return units.map((u) => ({
    name: u.name,
    repoKey: repoKeyFor(u.repo, repos),
    ownedPaths: [...u.ownedPaths],
    deps: [...(u.deps ?? [])],
    contract: u.contract ?? false,
    estimate: { minutes: u.estimate?.minutes ?? null, tokens: u.estimate?.tokens ?? null },
  }));
}

const toCheck = (u: ProposedUnit): SplitUnit => ({ ...u });

/** Автор строки человека — тот же канал, что у приёма команды (`process.ts`). */
export function humanActorOf(task: LiveTask, cmdId: string): string {
  return task.state.commands[cmdId]?.proof.signature === 'valid' ? 'human:device' : 'human:panel';
}

/** Решение проверки — данные JSON (только строки, числа, массивы): строка `decision` его хранит. */
const asJson = (value: object): JournalJson => JSON.parse(JSON.stringify(value)) as JournalJson;
type JournalJson = JournalDataV1['decision']['output'];

/**
 * Предложение → проверка → решение. Три строки: `split.proposed`, `decision` (класс
 * `split-check`, выход несёт `splitId` и порядок), `split.decided`. Правка человека, прошедшая
 * проверку, — `edited`; принятое предложение плана — `accepted`.
 */
export function proposeSplit(
  task: LiveTask,
  units: readonly ProposedUnit[],
  source: ProposalSource,
  input: SplitFlowInput,
  env: SplitEnv,
): SplitOutcome {
  const splitId = newId();
  const cmd = source.cmdId ? { cmdId: source.cmdId } : {};
  const proposed = task.append({
    kind: 'split.proposed',
    actor: source.by === 'human' && source.cmdId ? humanActorOf(task, source.cmdId) : 'core',
    ...cmd,
    ...(source.stepId ? { stepId: source.stepId } : {}),
    data: { splitId, stepId: source.stepId, by: source.by, units: [...units] },
  });
  const created = task.state.created;
  const capacity = env.capacity();
  const decision = decideSplit({
    units: units.map(toCheck),
    deliverable: input.deliverable,
    capacity,
    foldCase: env.foldCase,
    ...(input.knownFiles ? { knownFiles: input.knownFiles } : {}),
    ...(created ? { repoKeys: created.repos.map((r) => r.repoKey) } : {}),
  });
  const decided = task.append({
    kind: 'decision',
    actor: 'core',
    cause: proposed.seq,
    ...cmd,
    data: {
      decisionId: newId(),
      class: 'split-check',
      inputs: [proposed.seq],
      facts: [{ readClass: 'git.history', kind: input.knownFiles ? 'value' : 'unknown' }],
      numbers: { units: units.length, slots: capacity.slots },
      reasons: decision.reasons,
      output: asJson({ splitId, ...decision }),
    },
  });
  const accepted = source.by === 'human' ? 'edited' : 'accepted';
  const outcome = decision.verdict === 'accepted' ? accepted : 'refused';
  const line = task.append({
    kind: 'split.decided',
    actor: 'core',
    cause: decided.seq,
    ...cmd,
    data: {
      splitId,
      outcome,
      by: outcome === 'edited' ? 'human' : 'core',
      decisionSeq: decided.seq,
    },
  });
  return { splitId, decision, decidedSeq: line.seq };
}

/** Оценка закончена: `estimating → awaiting-launch`; другое состояние — без перехода. */
export function markEstimated(task: LiveTask, cause: number, cmdId?: string): void {
  if (task.state.task !== 'estimating') return;
  task.append({
    kind: 'task.transition',
    actor: 'core',
    cause,
    ...(cmdId ? { cmdId } : {}),
    data: { taskId: task.taskId, event: 'estimated', from: 'estimating', to: 'awaiting-launch' },
  });
}

/** Запустить можно только принятое (ядром или правкой) или утверждённое деление. */
export function launchable(split: SplitRecordView | undefined): string[] {
  const missing: string[] = [];
  if (!split) return ['no split proposed yet'];
  if (!['accepted', 'edited', 'approved'].includes(split.state))
    missing.push(`split ${split.splitId} is ${split.state}, not accepted`);
  if (split.decision?.verdict !== 'accepted')
    missing.push(`split ${split.splitId} has no accepted check decision`);
  return missing;
}

function closeUnit(task: LiveTask, unitId: string, cause: number, cmdId?: string): void {
  const from = task.state.units[unitId]?.state;
  if (!from || from === 'closed' || from === 'done') return;
  task.append({
    kind: 'unit.transition',
    actor: 'core',
    unitId,
    cause,
    ...(cmdId ? { cmdId } : {}),
    data: { unitId, event: 'close', from, to: 'closed' },
  });
}

/**
 * Запуск деления: предпроверка (строка `signal preflight`, подпись `launch`), затем единицы и
 * `task.transition launch`. Отказ предпроверки — ничего не создано, причины названы.
 */
/**
 * Сценарий задачи на запуске: публикует ли он (дорога `git-version`; не разрешился — `undefined`,
 * дорога проверяется) и данные решения старшинства над тем же разрешением (P80).
 */
async function scenarioOfTask(
  task: LiveTask,
  env: SplitEnv,
): Promise<{ publishes: boolean | undefined; precedence: ReturnType<typeof scenarioPrecedence> | null }> {
  const created = task.state.created;
  if (!created) return { publishes: undefined, precedence: null };
  const ref = task.state.scenario?.ref ?? created.scenario;
  const got = await resolveScenario(ref, created.repos, { libraryDir: env.libraryDir });
  if (!got.ok) return { publishes: publishesOf(undefined), precedence: null };
  return {
    publishes: publishesOf(got.scenario.steps),
    precedence: scenarioPrecedence(got, {
      routes: allowedRoutesOf(task.state),
      level: created.routesSourceLevel,
    }),
  };
}

export async function launchSplit(
  task: LiveTask,
  env: SplitEnv,
  cmdId?: string,
): Promise<Exclude<AfterAccept, { kind: 'asked' }>> {
  const split = latestSplit(linesOf(task));
  const missing = launchable(split);
  const step = nextState(TASK_MACHINE, task.state.task, 'launch');
  if (!step.ok) missing.push(`launch not allowed in ${task.state.task}`);
  if (missing.length > 0 || !split)
    return { kind: 'launch-refused', code: 'split-not-approvable', reasons: missing };
  const repos = task.state.created?.repos ?? [];
  const resolved = await scenarioOfTask(task, env);
  const preflight = await runTaskPreflight(
    repos,
    allowedRoutesOf(task.state),
    env,
    resolved.publishes,
  );
  const pre = journalPreflight(task, 'launch', preflight, cmdId);
  if (!preflight.start) {
    return {
      kind: 'launch-refused',
      code: 'preflight-failed',
      reasons: preflight.rows
        .filter((r) => r.status === 'failed')
        .map((r) => `${r.road}: ${r.detail}`),
    };
  }
  // Решение старшинства на запуске (G1, P80): тот же вход, что у оценки и правки сценария.
  if (resolved.precedence)
    task.append({
      kind: 'decision',
      actor: 'core',
      cause: pre.seq,
      ...(cmdId ? { cmdId } : {}),
      data: { decisionId: newId(), ...resolved.precedence },
    });
  const decision = split.decision as Extract<SplitCheckDecision, { verdict: 'accepted' }>;
  const zeros = Object.entries(task.state.units).filter(([, u]) => u.splitId === null);
  const made: string[] = [];
  if (decision.solo) {
    // Соло: единица 0 продолжает — её ветка, копия и сессия плана остаются (G6).
    made.push(...zeros.map(([id]) => id));
  } else {
    for (const [id] of zeros) closeUnit(task, id, pre.seq, cmdId);
    const units = unitsOfSplit(decision, split.units.map(toCheck), split.splitId, newId);
    for (const u of units) {
      task.append({
        kind: 'unit.created',
        actor: 'core',
        unitId: u.unitId,
        cause: pre.seq,
        ...(cmdId ? { cmdId } : {}),
        data: u,
      });
      made.push(u.unitId);
    }
  }
  task.append({
    kind: 'task.transition',
    actor: 'core',
    cause: pre.seq,
    ...(cmdId ? { cmdId } : {}),
    data: { taskId: task.taskId, event: 'launch', from: task.state.task, to: 'running' },
  });
  // Пункт 10 решён запуском: ответ команды человека или снятие (P71, зона E).
  closeLaunchAsks(task, { splitId: split.splitId, ...(cmdId ? { cmdId } : {}) });
  return { kind: 'launched', units: made };
}

/** Политика после принятого деления (G16): `auto` — запуск, `confirm` — точка 10 человеку. */
export async function afterAccept(
  task: LiveTask,
  outcome: SplitOutcome,
  env: SplitEnv,
): Promise<AfterAccept> {
  markEstimated(task, outcome.decidedSeq);
  const policy = task.state.created?.launchPolicy ?? 'confirm';
  if (policy === 'auto') {
    const launched = await launchSplit(task, env);
    if (launched.kind === 'launched') return launched;
    // Автозапуск не прошёл предпроверку — решает человек, не тишина в «ждёт запуска».
    return askLaunch(task, outcome, env, launched.reasons);
  }
  return askLaunch(task, outcome, env, []);
}

function askLaunch(
  task: LiveTask,
  outcome: SplitOutcome,
  env: SplitEnv,
  blocked: string[],
): AfterAccept {
  const d = outcome.decision;
  let plan = 'refused';
  if (d.verdict === 'accepted')
    plan = d.solo ? 'one unit (no split)' : `${d.order.length} units: ${d.order.join(' → ')}`;
  const raised = env.raise(task, {
    source: 'launch',
    stepId: null,
    sessionId: null,
    action: { kind: 'launch', target: outcome.splitId },
    point: 10,
    dedupe: `split:${outcome.splitId}`,
    question:
      blocked.length > 0
        ? `Launch blocked by preflight: ${blocked.join('; ')}. Split: ${plan}.`
        : `Launch the task? Split: ${plan}.`,
    options: ['approve-split', 'edit-split', 'cancel'],
    recommendation: blocked.length > 0 ? 'fix the named roads, then approve' : 'approve-split',
    blocking: true,
  });
  return { kind: 'asked', raise: raised.kind };
}
