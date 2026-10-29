import type {
  CheckDecision,
  CheckDecisionInput,
  CheckEntry,
  CheckEntryRoad,
  CheckRecord,
  Unmet,
} from '@agentdeck/contracts/core/records';
import type { KeyVerdict } from './decide.types.ts';

/**
 * Решение по запросу проверки (00:94, 04 §Decision rules, D§3.5) — единственный судья класса
 * `check` (P01). Чистая функция: ключ, записи ключа, область, «идёт сейчас», окно — и ничего из
 * текста команды, истории повторов или транскрипта (D§3.5 P5): одинаковые входы — одинаковое
 * решение у любой дороги (захват, инструмент модели, дирижёр, простой — P02).
 *
 * Порядок: повтор записи ничего не стоит и окна не тратит — он первым; затем ожидание того же
 * ключа у соседа (single-flight), окно, препятствия (все разом — P03), и только потом прогон
 * в границах фазы (посреди работы — только изменённые единицы и только узко, 04:56).
 */

/** Нижняя граница ожидания соседнего прогона того же ключа (D§6: max(2× выученного, 10 мин)). */
export const WAIT_FLOOR_MS = 10 * 60_000;

/** Дороги захвата: записи сеанса (`session`, `pseudo`) повторяются только на них (G13, P05). */
const CAPTURE_ROADS: ReadonlySet<CheckEntryRoad> = new Set([
  'capture-preload',
  'capture-wrapper',
  'pseudo',
]);

/** Зелёный — `pass` или `pass-flaky` с замеренными повторами того же ключа (мутант M5, D§4). */
function isGreen(record: CheckRecord): boolean {
  if (record.verdict.kind === 'pass') return true;
  return record.verdict.kind === 'pass-flaky' && record.verdict.retries.length > 0;
}

/**
 * Запись, которой можно ответить на этой дороге: `unattended` — никогда, сеанс — только на
 * дорогах захвата (G13); без восстановимых артефактов — нечем повторить (D§3.4). Запись без
 * вердикта (G2) отсекает `keyVerdict`: она не красная и не зелёная, ответом не становится.
 */
function replayable(record: CheckRecord, road: CheckEntryRoad): boolean {
  if (record.artifacts === null) return false;
  if (record.origin === 'core') return true;
  if (record.origin === 'unattended') return false;
  return CAPTURE_ROADS.has(road);
}

/**
 * Вердикт ключа по его записям во времени. Красный остаётся красным, пока ПОСЛЕ него не пришёл
 * доказанный зелёный (`pass-flaky` с повторами). Простой зелёный рядом с красным на том же
 * содержимом — нестабильность (`flaky-unresolved`), а не зелёный: «последний побеждает» спрятал
 * бы красный за случайным зелёным.
 */
export function keyVerdict(records: readonly CheckRecord[]): KeyVerdict {
  const rs = [...records].sort((a, b) => a.startedAt - b.startedAt);
  const reds = rs.filter((r) => r.verdict.kind === 'fail');
  const greens = rs.filter(isGreen);
  const lastRed = reds.at(-1);
  if (!lastRed) {
    const last = greens.at(-1);
    return last ? { kind: 'green', record: last } : { kind: 'none' };
  }
  const after = rs.filter((r) => r.startedAt > lastRed.startedAt);
  const proven = after.filter((r) => r.verdict.kind === 'pass-flaky' && isGreen(r)).at(-1);
  if (proven) return { kind: 'green', record: proven };
  const mixed = after.some(isGreen) || greens.some((r) => r.startedAt < lastRed.startedAt);
  return mixed ? { kind: 'flaky-unresolved', record: lastRed } : { kind: 'red', record: lastRed };
}

/** Повторы тестов положены только прогону тестов, не зависящему от базы (D§3.7, G4). */
function retryable(entry: CheckEntry): boolean {
  return entry.class === 'test-runner' && !entry.baseDependent;
}

function header(record: CheckRecord, unit: string, extra = ''): string {
  return (
    `[agentdeck] replay of ${record.checkId}@${unit}: record ${record.id} (${record.verdict.kind}), ` +
    `ran ${new Date(record.startedAt).toISOString()}, argv: ${record.argv.join(' ')}${extra}`
  );
}

function redHeader(record: CheckRecord, unit: string, quarantined: readonly string[]): string {
  const names = record.failing.map((f) => f.name);
  const known = names.filter((n) => quarantined.includes(n));
  const tail =
    ` — unchanged since; change the failing code first` +
    (names.length ? `: ${names.join('; ')}` : '') +
    (known.length ? ` (quarantined: ${known.join('; ')})` : '');
  return header(record, unit, tail);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function freshApplies(input: CheckDecisionInput, entry: CheckEntry): boolean {
  const f = input.fresh;
  if (!f) return false;
  if (f.scope === 'check') return f.ref === entry.id;
  if (f.scope === 'unit') return f.ref === input.unit;
  return 'value' in input.key && f.ref === input.key.value;
}

/**
 * Запрошенной проверки нет в реестре (04:62, G3): ответ — запись `fail{absent}` на ключе
 * «id проверки + отпечаток реестра». Есть такая запись — она; нет — `run` без команды: вызывающий
 * пишет запись `fail{absent}` (`absentRecordDraft`) и отвечает ею. Никогда не «зелёный».
 */
function decideAbsent(input: CheckDecisionInput): CheckDecision {
  if ('value' in input.key && 'value' in input.records) {
    const key = input.key.value;
    const absentRecord = input.records.value
      .filter((r) => r.key === key && r.verdict.kind === 'fail' && r.verdict.reason === 'absent')
      .sort((a, b) => a.startedAt - b.startedAt)
      .at(-1);
    if (absentRecord) return { kind: 'absent', recordId: absentRecord.id };
  }
  return {
    kind: 'run',
    grade: 'unit',
    selection: [],
    reason:
      'absent-unrecorded: not in the registry; write the fail{absent} record and answer with it',
  };
}

export function decideCheck(input: CheckDecisionInput): CheckDecision {
  const entry = input.entry;
  if (entry === null) return decideAbsent(input);
  const fresh = freshApplies(input, entry);
  const known = 'value' in input.key && 'value' in input.records;
  const atKey =
    'value' in input.key && 'value' in input.records
      ? input.records.value.filter((r) => r.key === (input.key as { value: string }).value)
      : [];

  // Вердикт ключа — по ВСЕМ его записям: красный, которым нельзя ответить (без артефактов,
  // сеанс вне дороги захвата, `unattended`), всё равно свидетельство о содержимом и не даёт
  // повторить зелёный старше него. Повторимость решает только, может ли выбранная запись стать
  // ответом; ключ зелёный по всем — ответом станет последний повторимый зелёный.
  const full = known && !fresh ? keyVerdict(atKey) : null;
  const verdict =
    full?.kind === 'green' ? keyVerdict(atKey.filter((r) => replayable(r, input.road))) : full;
  if (verdict && verdict.kind !== 'none') {
    const answerable = replayable(verdict.record, input.road);
    if (verdict.kind === 'green' && answerable)
      return {
        kind: 'replay',
        recordId: verdict.record.id,
        header: header(verdict.record, input.unit),
      };
    const redAnswer =
      verdict.kind === 'red' || (verdict.kind === 'flaky-unresolved' && !retryable(entry));
    if (redAnswer && answerable)
      return {
        kind: 'replay',
        recordId: verdict.record.id,
        header: redHeader(verdict.record, input.unit, input.quarantined),
      };
    if (verdict.kind === 'flaky-unresolved' && retryable(entry))
      return {
        kind: 'run',
        grade: 'retry',
        selection: verdict.record.failing.map((f) => f.name),
        reason: `flaky-unresolved at ${verdict.record.id}: rerun the failing tests alone (≤2, G4)`,
      };
  }

  if (input.inflight) {
    const learned = median(atKey.filter((r) => r.verdict.kind !== 'no-verdict').map((r) => r.ms));
    return {
      kind: 'wait',
      checkRunId: input.inflight.checkRunId,
      deadlineMs: input.inflight.since + Math.max(2 * learned, WAIT_FLOOR_MS),
    };
  }

  // G12: до фазы 5 окно не моделируется — дирижёр даёт `open`; отказ окна только откладывает.
  if (input.window.verdict === 'refused')
    return { kind: 'defer', until: 'window', reason: `window refused (${input.window.basis})` };

  if (input.blockers.length > 0) {
    if (input.blockers.every((b) => b.code === 'disk'))
      return {
        kind: 'defer',
        until: 'disk',
        reason: input.blockers.map((b) => b.subject).join('; '),
      };
    return refuse(input.blockers);
  }

  const why = !known
    ? `doubt → run (key ${'unknown' in input.key ? input.key.unknown : 'value' in input.key ? 'read' : 'absent'}, records ${'unknown' in input.records ? input.records.unknown : 'read'})`
    : fresh
      ? `fresh one-shot (${input.fresh?.scope} ${input.fresh?.ref})`
      : full && full.kind !== 'none'
        ? `latest ${full.kind} at this key (${full.record.id}) is not replayable on this road`
        : atKey.length
          ? 'no verdict-bearing record at this key'
          : 'no record at this key';

  if (input.phase === 'mid-task') {
    // Посреди работы весь набор — 0 (04:56): нетронутая единица не гоняется, гонятся изменённые.
    if (!fresh && !input.changedUnits.includes(input.unit))
      return {
        kind: 'narrow',
        units: [...input.changedUnits].sort(),
        selection: [],
        reason: `mid-task: ${input.unit} is outside the changed scope; only changed units run`,
      };
  }
  // Разряд — то, что прогон покроет, а не фаза: вся изменённая единица посреди работы — `unit`, иначе
  // её зелёный не годился бы итогу на том же дереве и гонялся бы второй раз (A1r4-F02).
  return input.selection.length > 0
    ? { kind: 'run', grade: 'narrow', selection: [...input.selection], reason: why }
    : { kind: 'run', grade: 'unit', selection: [], reason: why };
}

/** P03: один отказ называет ВСЕ невыполненные условия и следующее действие по каждому. */
function refuse(unmet: readonly Unmet[]): CheckDecision {
  const seen = new Set<string>();
  const all = unmet.filter((u) => {
    const id = `${u.code}\u0000${u.subject}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { kind: 'refuse', unmet: all, next: all.map((u) => `${u.subject}: ${u.next}`).join('; ') };
}
