import type {
  CheckAnswer,
  CheckEntry,
  CheckRecord,
  CheckRequest,
  Verdict,
} from '@agentdeck/contracts/core/records';
import { afterRecord, quarantineAdd } from '../../../verifier/flaky/index.ts';
import type { RunResult } from '../../../verifier/run/run.types.ts';
import type { RecordDraft } from '../../../verifier/store/index.ts';
import { flagLike, why } from './helpers.ts';
import { journal, move, requested } from './journal.ts';
import type { Gathered, Held, ServiceState } from './request.types.ts';
import { runOnce } from './run-once.ts';

/**
 * Красный раннер тестов с фильтром (G4): те же упавшие тесты, тем же ключом, ≤2 раз, под той же
 * арендой. Зелёный повтор — запись единицы `pass-flaky` с номерами повторов и карантин сразу.
 */
export async function flakyChain(
  s: ServiceState,
  req: CheckRequest,
  g: Gathered,
  entry: CheckEntry,
  unit: string,
  first: { recordId: string; verdict: Verdict; result: RunResult },
  held: Held,
): Promise<CheckAnswer | null> {
  const { deps } = s;
  if (!('value' in g.store) || !('value' in g.key)) return null;
  const store = g.store.value;
  const original = store.record(first.recordId);
  if (!('value' in original)) return null;
  const history: CheckRecord[] = [original.value];
  let plan = afterRecord(original.value, entry, []);
  while (plan && plan.kind === 'retry') {
    // Упавший тест с именем-флагом в argv повтора не идёт: красный остаётся красным.
    if (plan.tests.some((t) => flagLike(t.name))) return null;
    const retryRunId = deps.newId();
    requested(s, req, entry, unit, g.key.value.key, 'retry', retryRunId, held.checkRunId);
    move(s, req, retryRunId, 'lease', 'queued', 'leased');
    const out = await runOnce(
      s,
      req,
      g,
      entry,
      unit,
      'retry',
      plan.tests.map((t) => t.name),
      { ...held, checkRunId: retryRunId },
    );
    if (out.recordId === null) return null;
    const rec = store.record(out.recordId);
    if (!('value' in rec)) return null;
    plan = afterRecord(rec.value, entry, history);
    history.push(rec.value);
  }
  if (!plan || plan.kind === 'red') return null;
  // Доказанный переход: вывод единицы — запись `pass-flaky` на том же ключе. Вывод — свой прогон
  // со своим номером (A1r4-F06): номер красного уже записан, вторая запись на нём — аномалия
  // свёртки, и вывод остался бы без `check.recorded`. Связь с красным — `retryOf`.
  const head = history[0] as CheckRecord;
  const runId = deps.newId();
  requested(s, req, entry, unit, head.key, head.grade, runId, held.checkRunId);
  move(s, req, runId, 'lease', 'queued', 'leased');
  move(s, req, runId, 'start', 'leased', 'running');
  const conclusion: RecordDraft = {
    key: head.key,
    parts: head.parts,
    checkId: head.checkId,
    unit: head.unit,
    grade: head.grade,
    origin: head.origin,
    verdict: { kind: 'pass-flaky', retries: plan.retries },
    exit: 0,
    ms: history.reduce((sum, r) => sum + r.ms, 0),
    startedAt: deps.now(),
    argv: head.argv,
    failing: [],
    retries: plan.retries,
    artifacts: head.artifacts,
    envPrepared: head.envPrepared,
    standEpoch: history.at(-1)?.standEpoch ?? null,
    taskId: req.taskId,
    checkRunId: runId,
  };
  const written = store.write(
    conclusion,
    `pass-flaky: ${head.id} red, green retry among ${plan.retries.join(', ')}\n`,
  );
  const names = head.failing.map((f) => f.name).join('; ');
  // Вывода нет в хранилище — карантин не пишется: он назвал бы переход, которого нет в записях.
  if (!('value' in written)) {
    move(s, req, runId, 'no-verdict', 'running', 'no-verdict');
    return {
      kind: 'ran',
      recordId: null,
      checkRunId: runId,
      verdict: conclusion.verdict,
      exit: 0,
      failing: [],
      note: `store refused the write: ${why(written)}; flaky ${names} not quarantined`,
    };
  }
  journal(s, req, {
    kind: 'check.recorded',
    stepId: req.stepId,
    data: { checkRunId: runId, recordId: written.value },
  });
  move(s, req, runId, 'record', 'running', 'recorded');
  const q = deps.quarantine?.(req);
  let quarantined = `flaky: ${names} quarantined`;
  if (!q || !deps.writeQuarantine) quarantined = `flaky: ${names}; quarantine not wired`;
  else if (!('value' in q)) quarantined = `flaky: ${names}; quarantine unread (${why(q)})`;
  else deps.writeQuarantine(req, quarantineAdd(q.value, plan.quarantine));
  return {
    kind: 'ran',
    recordId: written.value,
    checkRunId: runId,
    verdict: conclusion.verdict,
    exit: 0,
    failing: [],
    note: quarantined,
  };
}
