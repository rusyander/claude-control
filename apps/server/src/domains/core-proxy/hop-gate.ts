import {
  HOP_RECORD_ENV,
  hopVerdictOf,
  readHopRecord,
  type HopRecordFile,
} from '../../lib/hop-recorder.mjs';

/**
 * Прокладка не пересылает команду ядру, пока сторож не записал этот сервер звеном (P131): сторож
 * пишет звенья сразу после запуска сервера, но запись и подъём сервера идут параллельно, и первая
 * команда могла дойти до ядра раньше записи — пир без доверия, отказ `signature-required` у
 * команды, которая через полсекунды прошла бы. Итог записи сторож кладёт в файл
 * (`AGENTDECK_HOP_RECORD`), здесь его ждут по каналу надзора того ядра, куда идёт команда.
 *
 * Ждут не вечно: сторож умер или ядро отказало — команда уходит как есть, и ядро судит её само
 * (строгая — по подписи устройства). Канал, однажды не дождавшийся записи, дальше не ждут:
 * иначе каждая команда без сторожа стояла бы весь срок.
 */

export type HopGateVerdict = 'recorded' | 'refused' | 'timeout';

export interface HopGateDeps {
  file: string;
  /** pid этого сервера: звеном записан именно он. */
  pid: number;
  timeoutMs?: number;
  pollMs?: number;
  read?: (file: string) => HopRecordFile | null;
  sleep?: (ms: number) => Promise<void>;
}

export type HopGate = (channel: string) => Promise<HopGateVerdict>;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_MS = 50;

export function createHopGate(deps: HopGateDeps): HopGate {
  const read = deps.read ?? readHopRecord;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const recorded = new Set<string>();
  const gaveUp = new Set<string>();
  return async (channel) => {
    if (recorded.has(channel)) return 'recorded';
    const started = Date.now();
    for (;;) {
      const verdict = hopVerdictOf(read(deps.file), channel, deps.pid);
      if (verdict === 'recorded') {
        recorded.add(channel);
        return verdict;
      }
      if (verdict === 'refused') return verdict;
      if (gaveUp.has(channel) || Date.now() - started >= timeoutMs) {
        gaveUp.add(channel);
        return 'timeout';
      }
      await sleep(pollMs);
    }
  };
}

/** Сервер запущен сторожем, который пишет итог записи, — ворота; иначе ждать некого. */
export function hopGateFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  pid: number = process.pid,
): HopGate | undefined {
  const file = env[HOP_RECORD_ENV];
  if (!file || file.trim() === '') return undefined;
  return createHopGate({ file, pid });
}
