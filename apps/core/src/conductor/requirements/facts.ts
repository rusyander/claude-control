import type { Fact } from '@agentdeck/contracts/core/facts';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { LiveTask } from '../../journal/resume.ts';
import { gateFactsOf, type CheckStanding, type GateFacts } from '../gates/index.ts';
import type {
  EvidenceReader,
  ModelToolDeps,
  SessionBinding,
} from '../model-tools/model-tools.types.ts';
import { decideRequirements } from './decide.ts';
import { evidenceProblem } from './evidence.ts';
import { citedEvidence, requirementsInputOf } from './journal-view.ts';
import type {
  EvidenceStanding,
  RequirementsDecision,
  RequirementsInput,
} from './requirements.types.ts';

/**
 * Факты после шага (02:43-47): каждая запись, на которую опирается «покрыто», перечитывается —
 * тем же судом, что `step_done` (запись, ключ на текущем дереве, охват изменённых файлов), —
 * дифф единицы против базы, последние записи проверок для ворот. Шаг мог закончиться давно:
 * свежесть на момент заявления ничего не говорит о дереве сейчас (G22).
 *
 * Дифф единицы не прочитался — отказ (`git.diff-unit`, `onUnknown: refuse`): судить «покрыто»
 * против неизвестного набора изменений нельзя, и «ничего не изменено» им не подставляется.
 */

export interface PostStepDeps {
  records: ModelToolDeps['records'];
  evidence: EvidenceReader;
}

export interface PostStepFacts {
  input: RequirementsInput;
  decision: RequirementsDecision;
  changed: string[];
  gates: Omit<GateFacts, 'redBefore' | 'stepDefId'>;
}

const why = (f: Fact<unknown>): string => ('unknown' in f ? f.unknown : 'absent');

async function standingOf(
  task: LiveTask,
  b: SessionBinding,
  recordId: string,
  changed: Fact<string[]>,
  deps: PostStepDeps,
): Promise<EvidenceStanding> {
  const record = deps.records(recordId, task.taskId);
  if ('unknown' in record) return { unknown: `record: ${record.unknown}` };
  const now: Awaited<ReturnType<EvidenceReader['now']>> =
    'value' in record ? await deps.evidence.now(task, b, record.value) : { absent: true };
  if ('unknown' in now) return { unknown: `key on the current tree: ${now.unknown}` };
  const problem = evidenceProblem({ record, now, changed }, task.taskId);
  return problem === null ? 'current' : { stale: `${problem.code}: ${problem.detail}` };
}

async function checkStanding(
  task: LiveTask,
  b: SessionBinding,
  recordId: string,
  deps: PostStepDeps,
): Promise<Fact<CheckStanding>> {
  const record = deps.records(recordId, task.taskId);
  if (!('value' in record)) return 'unknown' in record ? record : { unknown: 'record missing' };
  const now = await deps.evidence.now(task, b, record.value);
  if (!('value' in now)) return { unknown: `key on the current tree: ${why(now)}` };
  return {
    value: { recordId, verdict: record.value.verdict, current: now.value.key === record.value.key },
  };
}

export async function postStepFacts(
  task: LiveTask,
  b: SessionBinding,
  lines: readonly JournalLine[],
  stepDefId: string,
  deps: PostStepDeps,
): Promise<Fact<PostStepFacts>> {
  const changed = await deps.evidence.changed(task, b);
  if (!('value' in changed)) return { unknown: `unit diff: ${why(changed)}` };
  const judged = requirementsInputOf(lines);
  const evidence: Record<string, EvidenceStanding> = {};
  for (const id of citedEvidence(judged))
    evidence[id] = await standingOf(task, b, id, changed, deps);
  const input: RequirementsInput = { ...judged, evidence };
  const decision = decideRequirements(input);
  const view = gateFactsOf(lines, stepDefId);
  const checks: Record<string, Fact<CheckStanding>> = {};
  for (const [checkId, recordId] of Object.entries(view.latestRecords))
    checks[checkId] = await checkStanding(task, b, recordId, deps);
  return {
    value: {
      input,
      decision,
      changed: changed.value,
      gates: {
        requirements: decision,
        checks,
        review: view.review ? { value: view.review } : { absent: true },
        confirmations: view.confirmations,
      },
    },
  };
}
