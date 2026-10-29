import type {
  CheckEntry,
  CheckKey,
  CheckRecord,
  ComposeDecision,
  CompositionInput,
  CompositionUnit,
  RecordGrade,
  Unmet,
} from '@agentdeck/contracts/core/records';
import { keyVerdict } from '../decide/index.ts';
import { retryable, unquarantineCandidates } from '../flaky/flaky.ts';
import { closureOf, covers } from '../key/index.ts';
import { classifyRed } from '../red/classify.ts';
import { isCodePath, isCoverageSource } from './coverage.ts';

/**
 * Итог на финальном дереве (D§3.6, 04:56-59, 04:82-86) — единственный судья класса `compose` (P01).
 * Чистая функция: обязательный набор = проверки `publish`/`deliver` × единицы, чьё замыкание задето
 * изменением (обвязка задета — все), плюс проверки всего репозитория. На единицу вердикт ключа решает
 * `keyVerdict` — тот же судья, что у `decide` (P01/P02): зелёная запись ядра в подготовленном
 * окружении — переиспользуется; красная того же ключа остаётся красной (без перепрогона), её класс
 * решает `red/classify`; простой зелёный рядом с красным — не зелёный (повтор или красный); нет
 * записи — прогон. Второй итог на том же дереве — ноль прогонов (04:57). Изменённый код, над которым
 * нет ни одной обязательной проверки, — отказ, не «готово» без единиц. Отказ называет ВСЕ
 * невыполненные условия (P03).
 */

const WHOLE_REPO = '.';

interface Pair {
  entry: CheckEntry;
  unit: string;
}

const ref = (checkId: string, unit: string): string => `${checkId}:${unit}`;

/** Запись, что может войти в итог (04:13, G13): ядро, подготовленное окружение, разряд единицы, есть вердикт. */
function composable(rec: CheckRecord, key: CheckKey, grade: RecordGrade): boolean {
  return (
    rec.key === key &&
    rec.origin === 'core' &&
    rec.envPrepared &&
    rec.grade === grade &&
    rec.verdict.kind !== 'no-verdict'
  );
}

function latest(records: readonly CheckRecord[]): CheckRecord | undefined {
  let best: CheckRecord | undefined;
  for (const r of records) if (!best || r.startedAt > best.startedAt) best = r;
  return best;
}

function touches(prefixes: readonly string[], changed: readonly string[]): boolean {
  return prefixes.some((p) => changed.some((c) => covers(p, c)));
}

function requiredPairs(input: CompositionInput): Pair[] {
  const { registry, changed } = input;
  const machinery = touches(registry.machinery, changed);
  const pairs: Pair[] = [];
  for (const entry of registry.checks) {
    if (!entry.requiredAt.some((at) => at === 'publish' || at === 'deliver')) continue;
    if (entry.unit !== 'package') {
      pairs.push({ entry, unit: WHOLE_REPO });
      continue;
    }
    for (const unit of Object.keys(registry.units).sort())
      if (machinery || touches(closureOf(registry, unit), changed)) pairs.push({ entry, unit });
  }
  return pairs;
}

interface Judged {
  unit?: CompositionUnit;
  run?: { checkId: string; unit: string; grade: RecordGrade };
  unmet?: Unmet;
  stale?: boolean;
  flaky?: boolean;
}

function judge(pair: Pair, input: CompositionInput): Judged {
  const { entry, unit } = pair;
  const id = ref(entry.id, unit);
  const keyRow = input.keys.find((k) => k.checkId === entry.id && k.unit === unit);
  // Ключ не посчитан или неизвестен — сомнение → прогон (04:55).
  if (!keyRow || !('value' in keyRow.key))
    return { run: { checkId: entry.id, unit, grade: 'unit' } };
  const key = keyRow.key.value;
  const all = input.records[key] ?? [];
  // Вердикт по ВСЕМ записям единицы с вердиктом (красный сеанса тоже красный), зелёный — только тот,
  // что может войти в итог; «последний побеждает» спрятал бы красный за случайным зелёным.
  const kv = keyVerdict(
    all.filter((r) => r.key === key && r.grade === 'unit' && r.verdict.kind !== 'no-verdict'),
  );
  if (kv.kind === 'flaky-unresolved' && retryable(entry))
    return { run: { checkId: entry.id, unit, grade: 'retry' } };
  const pick = kv.kind === 'green' ? keyVerdict(all.filter((r) => composable(r, key, 'unit'))) : kv;
  const rec = pick.kind === 'none' ? undefined : pick.record;
  // Красный, что в итог не входит (сеанс, неподготовленное окружение), — прогон ядра, не отказ по чужой записи.
  if (rec && !composable(rec, key, 'unit'))
    return { run: { checkId: entry.id, unit, grade: 'unit' } };
  if (!rec) {
    const last = latest(all.filter((r) => r.key === key && r.grade === 'unit'));
    // Узкая выборка не нашла ни одного теста — новый прогон с той же выборкой даст то же самое.
    if (last?.verdict.kind === 'no-verdict' && last.verdict.reason === 'selection')
      return {
        unmet: {
          code: 'selection-empty',
          subject: id,
          next: 'выборка тестов не совпала ни с одним тестом — поправьте имя теста в привязке и соберите итог снова',
        },
      };
    // Окружение или движок не дали вердикта — действие над окружением, не новый прогон по кругу.
    if (
      last?.verdict.kind === 'no-verdict' &&
      (last.verdict.reason === 'env' || last.verdict.reason === 'engine')
    )
      return {
        unmet: {
          code: 'service-env',
          subject: id,
          next: `окружение: ${last.verdict.reason} — почините сервис или движок и соберите итог снова`,
        },
      };
    return { run: { checkId: entry.id, unit, grade: 'unit' } };
  }
  const base: CompositionUnit = {
    checkId: entry.id,
    unit,
    key,
    recordId: rec.id,
    verdict: rec.verdict.kind,
    reused: rec.startedAt < input.since,
  };
  if (rec.verdict.kind === 'pass') return { unit: base };
  if (rec.verdict.kind === 'pass-flaky')
    return { unit: { ...base, redClass: 'flaky' }, flaky: true };
  const baseKey =
    keyRow.baseKey !== null && 'value' in keyRow.baseKey ? keyRow.baseKey.value : undefined;
  const baseRec =
    baseKey === undefined
      ? null
      : (latest((input.records[baseKey] ?? []).filter((r) => composable(r, baseKey, 'base'))) ??
        null);
  const red = classifyRed({
    final: rec,
    base: baseRec,
    inChangedClosure:
      unit === WHOLE_REPO || touches(closureOf(input.registry, unit), input.changed),
    changed: input.changed,
    quarantined: input.quarantine.filter((q) => q.checkId === entry.id),
    scenarioRequired: input.scenarioRequired.includes(entry.id),
  });
  if (red.kind === 'need-base') return { run: { checkId: entry.id, unit, grade: 'base' } };
  if (red.kind === 'rerun') return { run: { checkId: entry.id, unit, grade: 'unit' } };
  const unitOut: CompositionUnit = { ...base, redClass: red.red };
  if (red.red === 'stale') return { unit: unitOut, stale: true };
  if (red.red === 'flaky') return { unit: unitOut, flaky: true };
  return {
    unit: unitOut,
    unmet: {
      code: red.red === 'defect' ? 'red-unchanged' : 'service-env',
      subject: `${id} (${red.red}: ${red.why})`,
      next:
        red.red === 'defect'
          ? `шаг исправления: красный ${rec.id} не перепрогоняется, пока ключ единицы не сдвинется`
          : 'действие над окружением, не правка кода',
    },
  };
}

function coverageGaps(input: CompositionInput): string[] {
  const sources = input.changed.filter(isCoverageSource);
  if (!('value' in input.covered)) return sources;
  const covered = new Set(input.covered.value);
  return sources.filter((f) => !covered.has(f));
}

/**
 * Изменённый код, над которым не стоит ни одна обязательная пара: вне каждого замыкания (опечатка в
 * пути единицы, скрипт вне единиц) и не обвязка при непустом наборе. Иначе итог «готово» без единого
 * прогона — публикация без доказательства.
 */
function unproven(input: CompositionInput, pairs: readonly Pair[]): string[] {
  const machinery = (path: string): boolean =>
    input.registry.machinery.some((p) => covers(p, path));
  return input.changed.filter(
    (path) =>
      isCodePath(path) &&
      !(pairs.length > 0 && machinery(path)) &&
      !pairs.some((p) => closureOf(input.registry, p.unit).some((c) => covers(c, path))),
  );
}

export function compose(input: CompositionInput): ComposeDecision {
  const pairs = requiredPairs(input);
  const judged = pairs.map((pair) => judge(pair, input));
  const runs = judged.flatMap((j) => (j.run ? [j.run] : []));
  const unmet = judged.flatMap((j) => (j.unmet ? [j.unmet] : []));
  const orphans = unproven(input, pairs);
  // Прогон этого не починит — условие в отказ сразу, вместе с прочими (P03).
  if (orphans.length > 0)
    unmet.push({
      code: 'unit-unknown',
      subject: orphans.join(', '),
      next: 'изменённый код вне всех единиц реестра — добавьте единицу или проверку всего репозитория, что его покрывает',
    });
  // Невыполненное окружение не ждёт прогонов: прогон его не починит, а отказ должен быть полным (P03).
  if (runs.length > 0 && unmet.length === 0) return { kind: 'run', units: runs };
  const gaps = coverageGaps(input);
  if (input.coverage === 'require' && gaps.length > 0)
    unmet.push({
      code: 'coverage-gap',
      subject: gaps.join(', '),
      next: 'привяжите кейс или тест, чей прогон касается файла',
    });
  for (const r of runs)
    unmet.push({
      code: 'record-missing',
      subject: ref(r.checkId, r.unit),
      next: `прогон разряда ${r.grade} после устранения остального`,
    });
  if (unmet.length > 0)
    return {
      kind: 'refuse',
      unmet,
      next: unmet
        .map((u) => u.next)
        .filter(unique)
        .join('; '),
    };
  const units = judged.flatMap((j) => (j.unit ? [j.unit] : []));
  return {
    kind: 'ready',
    compositionId: input.compositionId,
    units,
    flaky: judged.flatMap((j) => (j.flaky && j.unit ? [ref(j.unit.checkId, j.unit.unit)] : [])),
    stale: judged.flatMap((j) => (j.stale && j.unit ? [ref(j.unit.checkId, j.unit.unit)] : [])),
    coverageGaps: gaps,
    unquarantine: unquarantineCandidates(input.quarantine).map((q) => q.test),
  };
}

function unique(value: string, index: number, all: string[]): boolean {
  return all.indexOf(value) === index;
}
