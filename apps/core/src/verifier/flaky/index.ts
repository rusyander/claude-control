/** Флаки и карантин ядра (G4, D§3.7). */
export {
  afterRecord,
  MAX_RETRIES,
  noteQuarantineRun,
  quarantineAdd,
  retryable,
  UNQUARANTINE_GREENS,
  unquarantineCandidates,
} from './flaky.ts';
export { QUARANTINE_FILE, readQuarantine, writeQuarantine } from './quarantine-file.ts';
export type { FlakyPlan, QuarantineFile } from './flaky.types.ts';
