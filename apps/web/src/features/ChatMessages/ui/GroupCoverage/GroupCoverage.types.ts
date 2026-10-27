import type { GroupWatchCoverage } from '@agentdeck/contracts/group-watch';

export interface GroupCoverageProps {
  /** Охват сторожа живой группы с сервера (вид дерева, `watchCoverage`). */
  coverage: GroupWatchCoverage;
}
