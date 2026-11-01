/** Типы для `hop-recorder.mjs` — запись звеньев пересылки ядру из сторожей панели (P131). */

export declare const CORE_HOME_ENV: 'AGENTDECK_CORE_HOME';
export declare const HOP_RECORD_ENV: 'AGENTDECK_HOP_RECORD';

export declare function coreHomeOf(env?: NodeJS.ProcessEnv): string;

export declare function listenerPid(
  port: number,
  platform?: string,
  exec?: (file: string, args: readonly string[], options: object) => string | Buffer,
): number;

export type HopRecord =
  | {
      channel: string;
      ok: true;
      accepted: number[];
      refused: { pid: number; reason: string }[];
      recordedAt: number;
    }
  | { channel: string; ok: false; code: string; detail?: string };

export declare function recordHops(opts: {
  coreHome?: string;
  pids: readonly number[];
  /** Только эти каналы; нет — все каналы строк `procs.json`. */
  channels?: readonly string[];
}): Promise<HopRecord[]>;

export declare function supervisorsOf(coreHome: string): string[];

type HopReply =
  | Omit<Extract<HopRecord, { ok: true }>, 'channel'>
  | Omit<Extract<HopRecord, { ok: false }>, 'channel'>;

export interface HopRecordFile {
  v: 1;
  pids: number[];
  channels: Record<string, HopReply>;
}

export declare function writeHopRecord(
  file: string,
  pids: readonly number[],
  channels: Record<string, HopReply>,
): void;

export declare function readHopRecord(file: string): HopRecordFile | null;

export declare function hopVerdictOf(
  record: HopRecordFile | null,
  channel: string,
  pid: number,
): 'recorded' | 'refused' | 'pending';

export declare function watchHops(opts: {
  coreHome?: string;
  pidsOf: () => readonly number[];
  file?: string;
  everyMs?: number;
  onRecord?: (results: HopRecord[], pids: readonly number[]) => void;
}): { refresh(): Promise<void>; stop(): void };

export declare function describeRecord(
  results: readonly HopRecord[],
  pids: readonly number[],
): string;
