import { READ_CLASSES } from '../../../../lib/facts/read-classes.ts';
import { absent, readFact } from '../../../../lib/facts/read-fact.ts';
import { newId } from '../../../../lib/ids/uuidv7.ts';
import { readGpuMemory, readRamMemory, type GpuMemory } from '../../../../platform/gpu.ts';
import { factReason, hasValue, type Fact } from '../../../../platform/os-kind.ts';
import {
  createLivenessProbe,
  type LivenessProbe,
  type LivenessQuestion,
  type ProcessIdentity,
} from '../../../../platform/process-identity.ts';
import type { WaitOwner } from '../lease-state.ts';
import { createSlotQueue, type SlotQueue } from '../slot.ts';
import {
  MIB,
  type ForeignLease,
  type Held,
  type LiveWaiter,
  type LivenessRead,
  type OwnRouteOptions,
  type Pending,
} from './types.ts';

/**
 * Приставка старта ядра, чей снимок о самом себе не ответил при возврате состояния: такой
 * старт ни с одной строкой таблицы не совпадёт, поэтому читается не по личности, а по номеру.
 */
export const UNPROVEN_START = 'unknown:';

/**
 * Общее состояние одного экземпляра `local:own`: настройки с умолчаниями, держимые аренды,
 * непрояснённые держатели и ждущие этого ядра. Модули маршрута получают его, а не друг друга.
 */
export interface OwnContext {
  options: OwnRouteOptions;
  id: string;
  slots: SlotQueue;
  slotKey: string;
  gpu: () => Promise<Fact<GpuMemory>>;
  ram: () => { totalBytes: number; freeBytes: number };
  tolerance: number;
  probe: LivenessProbe;
  bootId: string;
  reissueWindowMs: number;
  retryUntilMs: number;
  recheckMs: number;
  held: Map<string, Held>;
  /** Аренды живых (или непрояснённых) чужих ядер — слот за ними, сервер не наш (F-88). */
  foreign: Map<string, ForeignLease>;
  /** Принять чужую аренду, чей владелец умер (ставит возврат состояния); ложь — не сейчас. */
  adoptForeign?: (item: Pending) => Promise<boolean>;
  /** Ключ: `server:<leaseId>` / `waiter:<taskId>` / `lease:<leaseId>`. */
  pending: Map<string, Pending>;
  live: Set<LiveWaiter>;
  /** Когда это ядро вернуло состояние прошлого (0 — ещё нет). */
  restoredAt: number;
  /** Это ядро как владелец мест ждущих; есть после возврата состояния. */
  self?: WaitOwner;
  /** Живость по личности; «неизвестно» — с причиной от ОС; `fresh` — без кэша такта. */
  liveness(
    identity: ProcessIdentity | undefined,
    question?: LivenessQuestion,
  ): Promise<LivenessRead>;
  readGpu(): Promise<Fact<GpuMemory>>;
}

const SHARED_SLOTS = createSlotQueue();

export function createOwnContext(options: OwnRouteOptions): OwnContext {
  const probe = options.probe ?? createLivenessProbe();
  const gpu = options.gpu ?? (() => readGpuMemory());

  async function liveness(
    identity: ProcessIdentity | undefined,
    question?: LivenessQuestion,
  ): Promise<LivenessRead> {
    if (!identity) return { live: 'absent' };
    // Старт владельца не был прочитан, когда он писал место: сверить личность нечем. Живой
    // номер — «неизвестно» (F25: место живого ядра не снимается), номера нет — смерть.
    if (identity.start.startsWith(UNPROVEN_START)) {
      const table = await probe.snapshot();
      if (!hasValue(table)) return { live: 'unknown', reason: factReason(table) };
      const row = table.value.find((item) => item.pid === identity.pid);
      if (!row || row.zombie) return { live: 'dead' };
      return {
        live: 'unknown',
        reason: `pid ${identity.pid}: its start was not read when the place was written; identity unprovable`,
      };
    }
    const state = await probe.isAlive(identity, question);
    if (state !== 'unknown') return { live: state };
    const table = await probe.snapshot();
    return {
      live: state,
      reason:
        'unknown' in table
          ? table.unknown
          : `pid ${identity.pid}: start time not exposed by the OS`,
    };
  }

  const readGpu = (): Promise<Fact<GpuMemory>> =>
    readFact('gpu.memory', async () => {
      const fact = await gpu();
      if ('value' in fact) return fact.value;
      if ('absent' in fact) return absent();
      throw new Error(fact.unknown);
    });

  return {
    options,
    id: options.id ?? 'local:own',
    slots: options.slots ?? SHARED_SLOTS,
    slotKey: options.slotKey ?? 'gpu',
    gpu,
    ram: options.ram ?? readRamMemory,
    tolerance: options.toleranceBytes ?? 256 * MIB,
    probe,
    bootId: options.core?.bootId ?? newId(),
    reissueWindowMs: options.reissueWindowMs ?? 5 * 60_000,
    retryUntilMs: options.livenessRetryMs ?? READ_CLASSES['process.alive'].retryUntilMs,
    recheckMs: options.recheckMs ?? 2_000,
    held: new Map(),
    foreign: new Map(),
    pending: new Map(),
    live: new Set(),
    restoredAt: 0,
    liveness,
    readGpu,
  };
}
