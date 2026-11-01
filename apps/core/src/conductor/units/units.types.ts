import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';

/** Единица, как её записал `unit.created` (02:73-74): свои пути, предшественники, контракт. */
export type UnitCreated = JournalDataV1['unit.created'];

/**
 * От чего растёт ветка единицы (02:73, G19): от приколотой базы задачи или от ветки последнего
 * предшественника в том же репозитории (его правки уже в её основе).
 */
export type UnitBase =
  | { kind: 'base'; repoKey: string; ref: string; sha: string }
  | { kind: 'predecessor'; unitId: string; branch: string };
