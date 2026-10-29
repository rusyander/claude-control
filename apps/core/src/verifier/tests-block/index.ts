/** Писатель блока тестов (04:65-67, P50, G14, G15) — прогоны кейсов из записей проверок ядра. */
export { readLinkedCases } from './cases.ts';
export { mainCheckoutOf } from './main-checkout.ts';
export { caseHits, inRecordScope } from './map.ts';
export { caseRunRecord, coreRunId, runFileId, TESTS_DIR, writeCaseRuns } from './write.ts';
export type { CaseHit, CaseScope, LinkedCase } from './tests-block.types.ts';
