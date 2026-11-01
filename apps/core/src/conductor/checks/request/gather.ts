import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  CheckAnswer,
  CheckRecord,
  CheckRequest,
  Unmet,
} from '@agentdeck/contracts/core/records';
import { absentKeyOf, type KeyOf } from '../../../verifier/key/index.ts';
import { absentRecordDraft, type RecordStore } from '../../../verifier/store/index.ts';
import { matchRequest } from '../match.ts';
import { checkWindow, EMPTY_REGISTRY, why } from './helpers.ts';
import type { Gathered, ServiceState } from './request.types.ts';

/** Чтения до решения (реестр → запись → ключ → записи ключа и «в полёте») и ответы по записям. */

export async function gather(
  s: ServiceState,
  req: CheckRequest,
  lockTimeout: boolean,
): Promise<Gathered> {
  const { deps } = s;
  const store = deps.store(req);
  const registry = await deps.registry(req);
  const reg = 'value' in registry ? registry.value : null;
  const match = matchRequest(req, reg);
  const selection = match.kind === 'derived' ? [] : [...(req.selection ?? [])];
  let key: Fact<KeyOf>;
  if (match.kind === 'absent') {
    key = reg ? { value: absentKeyOf(match.checkId, reg) } : { unknown: why(registry) };
  } else {
    key = await deps.key({
      req,
      entry: match.entry,
      registry: reg ?? EMPTY_REGISTRY,
      unit: match.unit,
      selection,
    });
  }
  const records: Fact<CheckRecord[]> = !('value' in store)
    ? { unknown: `store: ${why(store)}` }
    : 'value' in key
      ? (() => {
          const scan = store.value.scan(key.value.key);
          return 'value' in scan ? { value: scan.value.records } : scan;
        })()
      : { unknown: 'key not read' };
  const flight =
    'value' in key && !lockTimeout ? deps.queue.inflight(req.project, key.value.key) : null;
  const quarantine = deps.quarantine?.(req);
  const blockers: Unmet[] = [...((await deps.blockers?.(req)) ?? [])];
  // Вся копия (`.`) изменённой считается всегда: какие пути вне единиц тронуты, вход не знает.
  const changedUnits =
    match.kind !== 'absent' && match.unit === '.' ? ['.'] : [...req.changedUnits];
  return {
    store,
    registry,
    match,
    selection,
    key,
    records,
    input: {
      road: req.road,
      entry: match.kind === 'absent' ? null : match.entry,
      unit: match.kind === 'absent' ? '' : match.unit,
      selection,
      blockers,
      key: 'value' in key ? { value: key.value.key } : key,
      records,
      inflight: flight && 'value' in flight && flight.value ? flight.value : null,
      phase: req.phase,
      changedUnits,
      window: checkWindow(deps.window?.(req) ?? [], req.phase),
      fresh: deps.fresh?.(req) ?? null,
      quarantined: quarantine && 'value' in quarantine ? quarantine.value.map((q) => q.test) : [],
    },
  };
}

function recordOf(store: Fact<RecordStore>, id: string): Fact<CheckRecord> {
  return 'value' in store ? store.value.record(id) : { unknown: why(store) };
}

export function replayAnswer(g: Gathered, recordId: string, header: string): CheckAnswer {
  const rec = recordOf(g.store, recordId);
  return {
    kind: 'replay',
    recordId,
    verdict: 'value' in rec ? rec.value.verdict.kind : 'no-verdict',
    exit: 'value' in rec ? rec.value.exit : null,
    header: 'value' in rec ? header : `${header} (record unreadable: ${why(rec)})`,
  };
}

export function writeAbsent(
  s: ServiceState,
  req: CheckRequest,
  g: Gathered,
  checkId: string,
): CheckAnswer {
  const { deps } = s;
  const reg = 'value' in g.registry ? g.registry.value : null;
  if (!reg || !('value' in g.store))
    return {
      kind: 'refuse',
      unmet: [
        {
          code: 'registry-unreadable',
          subject: `registry: ${why(g.registry)}; store: ${'value' in g.store ? 'ok' : why(g.store)}`,
          next: 'make the profile and the record store readable, then ask again',
        },
      ],
      next: 'ask again once the registry reads',
    };
  const draft = absentRecordDraft({
    checkId,
    registry: reg,
    startedAt: deps.now(),
    origin: req.origin,
    checkRunId: null,
    taskId: req.taskId,
  });
  const written = g.store.value.write(draft, `check ${checkId} is not in the registry\n`);
  if (!('value' in written))
    return {
      kind: 'refuse',
      unmet: [
        { code: 'record-missing', subject: why(written), next: 'free the store and ask again' },
      ],
      next: 'ask again',
    };
  return { kind: 'absent', recordId: written.value };
}
