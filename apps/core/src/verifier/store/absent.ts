import type { CheckRegistry, RecordOrigin } from '@agentdeck/contracts/core/records';
import { absentKeyOf } from '../key/index.ts';
import type { RecordDraft } from './store.types.ts';

/**
 * Черновик записи `fail{absent}` (04:62, G3): запрошенной проверки нет в реестре — это красный,
 * никогда не «зелёный» и не «пропущено». Ключ — id проверки + отпечаток реестра, так что после
 * правки реестра запрос решается заново, а до неё отвечает уже записанное.
 */
export function absentRecordDraft(input: {
  checkId: string;
  registry: CheckRegistry;
  startedAt: number;
  origin: RecordOrigin;
  checkRunId: string | null;
  taskId: string | null;
}): RecordDraft {
  const { key, parts } = absentKeyOf(input.checkId, input.registry);
  return {
    key,
    parts,
    checkId: input.checkId,
    unit: '',
    grade: 'unit',
    origin: input.origin,
    verdict: { kind: 'fail', reason: 'absent' },
    exit: null,
    ms: 0,
    startedAt: input.startedAt,
    argv: [],
    failing: [],
    retries: [],
    // Повторять тут нечего, но и восстанавливать нечего: пустой список, а не null — запись отвечает.
    artifacts: [],
    envPrepared: false,
    standEpoch: null,
    taskId: input.taskId,
    checkRunId: input.checkRunId,
  };
}
