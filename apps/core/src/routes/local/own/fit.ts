import type { GpuMemory } from '../../../platform/gpu.ts';
import type { Fact } from '../../../platform/os-kind.ts';

/**
 * Подбор своей модели под память (11 R:PR-04, P129): ДО загрузки решение называет модель, её
 * размер, нужное (размер + запас на контекст и буферы) и свободное — по факту памяти карты, а
 * не по догадке. Единственный судья класса `fit` (реестр 00 §Decision classes).
 *
 * - Память карты прочитана и объём известен — `measured`: не влезает → `short`, загрузки нет
 *   (вытеснять чужое ядро не будет никогда).
 * - Счётчики WDDM знают занятое без объёма, факт `unknown` (локализованная Windows, нет
 *   инструмента) — `estimate`: загрузка идёт, и решение это называет (P129). Базовое занятое
 *   из счётчиков всё равно есть — по нему сверяется «память вернулась».
 * - Объединённая память (macOS) — подбор по ОЗУ, названный.
 */

export interface FitInput {
  model: { id: string; sizeBytes: number };
  gpu: Fact<GpuMemory>;
  ram: { totalBytes: number; freeBytes: number };
  /** Запас сверх файла модели: KV-кеш контекста, буферы вычислений. */
  overheadBytes: number;
}

export type FitTarget = 'gpu' | 'unified';

export type FitDecision =
  | {
      kind: 'fits';
      target: FitTarget;
      basis: 'measured' | 'estimate';
      device?: string;
      needBytes: number;
      freeBytes?: number;
      /** Занятое на всех картах до загрузки — с ним сверяется освобождение. */
      baselineUsedBytes?: number;
      reasons: string[];
    }
  | {
      kind: 'short';
      target: FitTarget;
      device?: string;
      needBytes: number;
      freeBytes: number;
      reasons: string[];
    };

/**
 * Окружение, привязывающее сервер к карте, которую выбрал подбор (F-69): иначе на нескольких
 * картах загрузка ушла бы на первую, а не на ту, где решение нашло память. Одна карта (или
 * подбор без карты) — привязывать нечего. NVIDIA: номер `nvidia-smi` — порядок шины PCI, его же
 * задаёт `CUDA_DEVICE_ORDER`; ROCm: номер `rocm-smi`. Окружение сервера из настроек — главнее.
 */
export function pinDeviceEnv(
  fit: FitDecision,
  memory: Fact<GpuMemory>,
  serverEnv: Readonly<Record<string, string>> = {},
): Record<string, string> {
  if (fit.kind !== 'fits' || fit.device === undefined || !('value' in memory)) return {};
  if (memory.value.devices.length < 2) return {};
  let pin: Record<string, string> = {};
  if (memory.value.source === 'nvidia-smi')
    pin = { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: fit.device };
  if (memory.value.source === 'rocm-smi') pin = { ROCR_VISIBLE_DEVICES: fit.device };
  return Object.fromEntries(Object.entries(pin).filter(([name]) => !(name in serverEnv)));
}

const GIB = 1024 ** 3;
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(2)} GiB`;

export function decideFit(input: FitInput): FitDecision {
  const needBytes = input.model.sizeBytes + input.overheadBytes;
  const need = `${input.model.id}: file ${gib(input.model.sizeBytes)} + overhead ${gib(input.overheadBytes)} = ${gib(needBytes)}`;
  const gpu = input.gpu;
  if (!('value' in gpu)) {
    const why = 'unknown' in gpu ? gpu.unknown : (gpu.detail ?? 'no gpu memory source');
    return {
      kind: 'fits',
      target: 'gpu',
      basis: 'estimate',
      needBytes,
      reasons: [need, `gpu memory unreadable (${why}): loading by estimate, release unverifiable`],
    };
  }
  const memory = gpu.value;
  const baselineUsedBytes = memory.devices.reduce((sum, device) => sum + device.usedBytes, 0);
  const target: FitTarget = memory.unified ? 'unified' : 'gpu';
  const measured = memory.devices.filter((device) => device.freeBytes !== undefined);
  if (measured.length === 0) {
    return {
      kind: 'fits',
      target,
      basis: 'estimate',
      needBytes,
      baselineUsedBytes,
      reasons: [
        need,
        `${memory.source} reports used ${gib(baselineUsedBytes)} without capacity: loading by estimate`,
      ],
    };
  }
  // Карта с наибольшим свободным: одна модель на карту, вторая ждёт слот, а не вытесняет.
  const best = measured.reduce((a, b) => ((b.freeBytes ?? 0) > (a.freeBytes ?? 0) ? b : a));
  const freeBytes = best.freeBytes ?? 0;
  const where = `${memory.source} device ${best.id}${best.name ? ` (${best.name})` : ''}: free ${gib(freeBytes)}`;
  if (freeBytes < needBytes) {
    return {
      kind: 'short',
      target,
      device: best.id,
      needBytes,
      freeBytes,
      reasons: [
        need,
        where,
        `short by ${gib(needBytes - freeBytes)}; ram free ${gib(input.ram.freeBytes)}`,
      ],
    };
  }
  return {
    kind: 'fits',
    target,
    basis: 'measured',
    device: best.id,
    needBytes,
    freeBytes,
    baselineUsedBytes,
    reasons: [need, where],
  };
}
