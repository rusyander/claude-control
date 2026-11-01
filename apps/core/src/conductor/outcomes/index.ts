/**
 * Исходы проверок на своём этапе шага (04:56-86): «красный до» после работы над багом, итог на
 * финальной проверке, прогоны ядра под арендой слота. Судьи — в `verifier/` (P01), здесь входы.
 */
export type * from './outcomes.types.ts';
export { withBaseTree, type BaseTreeInput } from './base-tree.ts';
export { finalGate, gatePairs, treeFp } from './final-gate.ts';
export { leasedRun, notStarted, type LeasedRunInput } from './leased-run.ts';
export { fixTests, isTestFile, redBeforeOf, unitOfFile } from './red-before.ts';
