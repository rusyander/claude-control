import type { CheckRecord, KeyParts } from '@agentdeck/contracts/core/records';

/**
 * Запись-образец зоны B для тестов итога, красных и флаки: подставное хранилище (план §3 «Stubs»),
 * пока хранилище зоны A не стоит в волне 2. Подпись не проверяется — её проверяет хранилище.
 */

const parts = (checkId: string, unit: string): KeyParts => ({
  v: 1,
  checkId,
  entryHash: 'e'.repeat(64),
  unit,
  selection: [],
  closure: 'c'.repeat(64),
  machinery: 'm'.repeat(64),
  base: null,
  inputs: 'i'.repeat(64),
  tools: {},
  env: {},
});

let seq = 0;

export function fixtureRecord(over: Partial<CheckRecord> = {}): CheckRecord {
  seq += 1;
  const key = over.key ?? 'k'.repeat(64);
  const checkId = over.checkId ?? 'tests';
  const unit = over.unit ?? 'app';
  return {
    v: 3,
    id: `${key}.${seq}`,
    key,
    parts: parts(checkId, unit),
    checkId,
    unit,
    grade: 'unit',
    origin: 'core',
    verdict: { kind: 'pass' },
    exit: 0,
    ms: 1000,
    startedAt: 1_000 + seq,
    argv: ['vitest', 'run'],
    failing: [],
    retries: [],
    artifacts: [],
    envPrepared: true,
    standEpoch: null,
    taskId: null,
    checkRunId: null,
    log: { bytes: 0, truncated: false, sha: '0'.repeat(64) },
    sig: 'sig',
    ...over,
  };
}

export const red = (
  failing: CheckRecord['failing'],
  over: Partial<CheckRecord> = {},
): CheckRecord =>
  // Итог раннера по умолчанию сходится с разбором: каждый упавший назван (A1r2-F04).
  fixtureRecord({
    verdict: { kind: 'fail', reason: 'red' },
    exit: 1,
    failing,
    failedCount: failing.length,
    ...over,
  });
