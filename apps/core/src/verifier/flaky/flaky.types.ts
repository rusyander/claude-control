import type { CheckRecord, QuarantineEntry, RecordId } from '@agentdeck/contracts/core/records';

type Failing = CheckRecord['failing'][number];

/**
 * Что делать после записи (G4, D§3.7, P38 флаки-половина). `retry` — прогнать ТОЛЬКО эти тесты
 * тем же ключом единицы (разряд `retry`); `pass-flaky` — доказанный переход: вердикт единицы
 * зелёный-флаки с номерами повторов и карантин этих тестов сразу; `red` — два красных повтора,
 * красный настоящий.
 */
export type FlakyPlan =
  | { kind: 'retry'; of: RecordId; tests: Failing[]; attempt: 1 | 2 }
  | { kind: 'pass-flaky'; of: RecordId; retries: RecordId[]; quarantine: QuarantineEntry[] }
  | { kind: 'red'; of: RecordId; retries: RecordId[] };

/** Список карантина хранилища `<store>/quarantine.json` (G4). */
export interface QuarantineFile {
  v: 1;
  entries: QuarantineEntry[];
}
