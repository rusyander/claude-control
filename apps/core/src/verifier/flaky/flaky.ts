import type { CheckEntry, CheckRecord, QuarantineEntry } from '@agentdeck/contracts/core/records';
import { sameTest } from '../red/test-path.ts';
import type { FlakyPlan } from './flaky.types.ts';

/**
 * Флаки и карантин (G4, D§3.7, 04:60-61, P38 флаки-половина, P75). Повторяются ТОЛЬКО упавшие
 * тесты (никогда весь набор ради одного теста, F20) и только у проверки-раннера тестов с фильтром;
 * детерминированные классы (static, lint, зависящие от базы) не повторяются никогда — их красный
 * повтором не лечится, а повтор прятал бы настоящий дефект. Зелёный повтор — доказанный переход:
 * `pass-flaky` с номерами повторов и карантин сразу. Два красных повтора — красный настоящий.
 */

export const MAX_RETRIES = 2;
/** Зелёных подряд, после которых тест из карантина предлагается вернуть (P75; решает человек). */
export const UNQUARANTINE_GREENS = 3;

/** Можно ли повторять проверку вообще: только раннер тестов с узким фильтром, не зависящий от базы. */
export function retryable(entry: CheckEntry): boolean {
  return entry.class === 'test-runner' && !entry.baseDependent && entry.filter !== undefined;
}

/**
 * Какие тесты повтор доказал прошедшими. Список прошедших есть — он. Нет (раннер их не называет,
 * P50) — только зелёный повтор ОДНОГО теста: узкий зелёный засчитан лишь при ≥1 выполненном тесте
 * (`narrowVerdict`), а фильтр — имя этого теста. Несколько имён без списка — ни один не доказан.
 */
function provenBy(rec: CheckRecord, selection: CheckRecord['failing']): CheckRecord['failing'] {
  if (rec.passing !== undefined) return rec.passing;
  return rec.verdict.kind === 'pass' && selection.length === 1 ? selection : [];
}

/**
 * Разбор назвал каждый упавший тест (A1r2-F04): итог раннера сходится с числом имён. Иначе повтор
 * названных «зеленеет» при живом неназванном и уводит красный в карантин. Итога нет — тоже нет.
 */
function fullyNamed(rec: CheckRecord): boolean {
  return rec.failedCount !== undefined && rec.failedCount === rec.failing.length;
}

/**
 * После записи: `rec` — только что записанная; `history` — цепочка до неё (исходная запись
 * единицы первой, затем повторы по порядку). Не флаки-случай — null.
 */
export function afterRecord(
  rec: CheckRecord,
  entry: CheckEntry,
  history: readonly CheckRecord[],
): FlakyPlan | null {
  if (!retryable(entry)) return null;
  if (rec.grade !== 'retry') {
    if (rec.grade !== 'unit' && rec.grade !== 'narrow') return null;
    if (rec.verdict.kind !== 'fail' || rec.verdict.reason !== 'red') return null;
    // Неразобранный красный повторять нечем — фильтр без имён прогнал бы всю единицу.
    if (rec.failing.length === 0) return null;
    if (!fullyNamed(rec)) return null;
    return { kind: 'retry', of: rec.id, tests: rec.failing, attempt: 1 };
  }
  const original = history[0];
  if (!original || original.grade === 'retry') return null;
  const retries = [...history.slice(1).map((r) => r.id), rec.id];
  if (rec.verdict.kind === 'pass') {
    // Зелёный повтор доказывает переход только тем тестам, что повторы назвали прошедшими:
    // выборка из нескольких имён «зеленеет», даже если одно имя не совпало ни с чем. Недоказанный
    // повтор — красный, ничего в карантин.
    const chain = [...history.slice(1), rec];
    const named = chain.flatMap((r, i) => provenBy(r, (chain[i - 1] ?? original).failing));
    if (!original.failing.every((t) => named.some((p) => sameTest(p, t))))
      return { kind: 'red', of: original.id, retries };
    return {
      kind: 'pass-flaky',
      of: original.id,
      retries,
      quarantine: original.failing.map((t) => ({
        test: t.name,
        ...(t.file !== undefined ? { file: t.file } : {}),
        checkId: original.checkId,
        since: rec.id,
        greensInRow: 0,
      })),
    };
  }
  // Повтор без вердикта (прерван, стенд) — не красный и не переход: решает вызывающий.
  if (rec.verdict.kind !== 'fail') return null;
  if (retries.length < MAX_RETRIES && rec.failing.length > 0 && fullyNamed(rec))
    return { kind: 'retry', of: original.id, tests: rec.failing, attempt: 2 };
  return { kind: 'red', of: original.id, retries };
}

/** Запись карантина как тест: тот же путь в другом файле — другой тест. */
const asTest = (q: QuarantineEntry): { name: string; file?: string } => ({
  name: q.test,
  ...(q.file !== undefined ? { file: q.file } : {}),
});

/** Добавить переход в список карантина; тест уже в карантине (та же проверка, путь и файл) не дублируется. */
export function quarantineAdd(
  entries: readonly QuarantineEntry[],
  add: readonly QuarantineEntry[],
): QuarantineEntry[] {
  const out = [...entries];
  for (const q of add)
    if (!out.some((e) => e.checkId === q.checkId && sameTest(asTest(e), asTest(q)))) out.push(q);
  return out;
}

/**
 * Тест в карантине бежит внутри каждого итога своей единицы (P75): +1 зелёный подряд — только когда
 * запись единицы назвала его прошедшим (пропущенный, переименованный, удалённый тест под зелёной
 * единицей не бежал — это не «зелёный»); красный тест — счёт с нуля. Тест без файла к единице не
 * привязать, запись без списка прошедших про тест молчит — счёт не трогается (не «зелёный» по догадке).
 */
export function noteQuarantineRun(
  entries: readonly QuarantineEntry[],
  rec: CheckRecord,
  inUnit: (file: string) => boolean,
): QuarantineEntry[] {
  if (rec.grade !== 'unit' || rec.origin !== 'core') return [...entries];
  if (rec.verdict.kind !== 'pass' && rec.verdict.kind !== 'fail') return [...entries];
  return entries.map((q) => {
    if (q.checkId !== rec.checkId) return q;
    const test = asTest(q);
    if (rec.failing.some((t) => sameTest(t, test))) return { ...q, greensInRow: 0 };
    if (q.file === undefined || !inUnit(q.file)) return q;
    if (!(rec.passing ?? []).some((t) => sameTest(t, test))) return q;
    return { ...q, greensInRow: q.greensInRow + 1 };
  });
}

export function unquarantineCandidates(entries: readonly QuarantineEntry[]): QuarantineEntry[] {
  return entries.filter((q) => q.greensInRow >= UNQUARANTINE_GREENS);
}
