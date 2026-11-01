import type { ForgePort, ForgeProject } from '@agentdeck/contracts/core/forge';

/**
 * Форж, которого ядро не знает (05: «another forge → push + link only, named as such»): пушит
 * публикатор git-ом, а этот порт честно говорит, что MR, нитей и CI у него нет — чтения
 * `unknown` с названной причиной (не «нет»: MR мог быть открыт руками), записи — «не умеет».
 */
export const GENERIC_REASON = 'generic forge: push + link only, no forge API';

export function createGenericPort(project: ForgeProject): ForgePort {
  const unknown = async () => ({ unknown: `${GENERIC_REASON} (${project.pushUrl})` });
  const unsupported = async () => ({ unsupported: GENERIC_REASON });
  return {
    kind: 'generic',
    whoAmI: unknown,
    mrBySourceBranch: unknown,
    mr: unknown,
    createMr: unsupported,
    updateMr: unsupported,
    threads: unknown,
    reply: unsupported,
    resolve: unsupported,
    mergeability: unknown,
    pipelines: unknown,
    jobLogTail: unknown,
    activitySince: unknown,
  };
}
