import { freemem, totalmem } from 'node:os';
import { darwinFreeBytes } from './machine.ts';
import { currentOs, type Fact, type OsKind } from './os-kind.ts';
import { powershellExe, runTool, type ToolRun } from './run-tool.ts';

/**
 * Память видеокарты по ОС (09 P129, 11 R:PR-04): подбор модели до загрузки и сверка «память
 * вернулась» после выгрузки читают ЭТО, а не догадку. Каждый источник — свой разбор записанного
 * вывода (`__fixtures__/gpu/`), поэтому ветка Linux и macOS проверяется и на Windows.
 *
 * Порядок источников:
 * - Windows: `nvidia-smi` (под WDDM он честно говорит про карту, хотя по процессам пишет
 *   `[N/A]`), иначе счётчик `\GPU Adapter Memory(*)\Dedicated Usage` — занятое без объёма.
 *   На локализованной Windows имена счётчиков другие: пустой ответ → `unknown` с причиной,
 *   подбор идёт по оценке и называет это (P129);
 * - Linux: `nvidia-smi`, иначе `rocm-smi --showmeminfo vram --json`;
 * - macOS: объединённая память — `sysctl hw.memsize` + `vm_stat`; подбор по ОЗУ, названный.
 * Нет ни одного источника — `unknown`, никогда «карты нет»: несработавший инструмент ≠ нет GPU.
 */

export type GpuSource = 'nvidia-smi' | 'wddm-counters' | 'rocm-smi' | 'unified-memory';

export interface GpuDevice {
  /** Номер карты у драйвера или LUID адаптера (WDDM). */
  id: string;
  name?: string;
  /** Нет у счётчиков WDDM: объём они не сообщают. */
  totalBytes?: number;
  usedBytes: number;
  freeBytes?: number;
}

export interface GpuMemory {
  source: GpuSource;
  devices: GpuDevice[];
  /** Память карты = ОЗУ (macOS): подбор по ОЗУ. */
  unified: boolean;
}

export type GpuTool = (file: string, args: readonly string[]) => Promise<ToolRun>;

const MIB = 1024 ** 2;

export const NVIDIA_SMI_ARGS = [
  '--query-gpu=index,name,memory.total,memory.used,memory.free',
  '--format=csv,noheader,nounits',
] as const;

export const WDDM_COUNTER_SCRIPT =
  "(Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { $_.Path + '=' + [int64]$_.CookedValue }";

export const ROCM_SMI_ARGS = ['--showmeminfo', 'vram', '--json'] as const;

const isCount = (text: string | undefined): text is string =>
  text !== undefined && /^\d+$/.test(text);

/** `index, name, total, used, free` в МиБ построчно; строка не той формы — весь вывод негоден. */
export function parseNvidiaSmi(out: string): GpuDevice[] | undefined {
  const devices: GpuDevice[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== 5) return undefined;
    const [index, name, total, used, free] = cells;
    if (!isCount(index) || !isCount(total) || !isCount(used) || !isCount(free)) return undefined;
    devices.push({
      id: index,
      ...(name ? { name } : {}),
      totalBytes: Number(total) * MIB,
      usedBytes: Number(used) * MIB,
      freeBytes: Number(free) * MIB,
    });
  }
  return devices.length > 0 ? devices : undefined;
}

/** Строки `\\host\gpu adapter memory(luid_…_phys_N)\dedicated usage=<байты>`. */
export function parseWddmCounters(out: string): GpuDevice[] | undefined {
  const devices: GpuDevice[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const hit = /adapter memory\((luid_[^)]+)\)\\dedicated usage=(\d+)\s*$/i.exec(raw.trim());
    if (hit) devices.push({ id: hit[1] ?? '', usedBytes: Number(hit[2]) });
  }
  return devices.length > 0 ? devices : undefined;
}

/** `rocm-smi --showmeminfo vram --json`: `{ "card0": { "VRAM Total Memory (B)": "…", "VRAM Total Used Memory (B)": "…" } }`. */
export function parseRocmSmi(out: string): GpuDevice[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const devices: GpuDevice[] = [];
  for (const [card, fields] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^card\d+$/.test(card) || !fields || typeof fields !== 'object') continue;
    const row = fields as Record<string, unknown>;
    const total = String(row['VRAM Total Memory (B)'] ?? '');
    const used = String(row['VRAM Total Used Memory (B)'] ?? '');
    if (!isCount(total) || !isCount(used)) return undefined;
    devices.push({
      id: card.slice('card'.length),
      totalBytes: Number(total),
      usedBytes: Number(used),
      freeBytes: Number(total) - Number(used),
    });
  }
  return devices.length > 0 ? devices : undefined;
}

/**
 * macOS: `sysctl -n hw.memsize` (байты) и `vm_stat` (страницы). Свободное = free + inactive +
 * speculative — то, что система отдаст модели без вытеснения.
 */
export function parseDarwinMemory(memsize: string, vmStat: string): GpuDevice[] | undefined {
  const total = memsize.trim();
  if (!isCount(total)) return undefined;
  const freeBytes = darwinFreeBytes(vmStat);
  if (freeBytes === undefined) return undefined;
  const totalBytes = Number(total);
  return [{ id: 'unified', totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes), freeBytes }];
}

function okText(run: ToolRun): string | undefined {
  return run.ok ? run.stdout : undefined;
}

export async function readGpuMemory(
  os: OsKind = currentOs(),
  run: GpuTool = runTool,
): Promise<Fact<GpuMemory>> {
  const tried: string[] = [];
  if (os === 'darwin') {
    const memsize = await run('sysctl', ['-n', 'hw.memsize']);
    const vm = await run('vm_stat', []);
    const devices = memsize.ok && vm.ok ? parseDarwinMemory(memsize.stdout, vm.stdout) : undefined;
    if (devices) return { value: { source: 'unified-memory', devices, unified: true } };
    return {
      unknown:
        `unified memory unreadable: ${memsize.ok ? '' : memsize.reason} ${vm.ok ? '' : vm.reason}`.trim(),
    };
  }
  const nvidia = await run('nvidia-smi', NVIDIA_SMI_ARGS);
  const fromNvidia = okText(nvidia);
  const nvidiaDevices = fromNvidia === undefined ? undefined : parseNvidiaSmi(fromNvidia);
  if (nvidiaDevices)
    return { value: { source: 'nvidia-smi', devices: nvidiaDevices, unified: false } };
  tried.push(`nvidia-smi: ${nvidia.ok ? 'unparsed output' : nvidia.reason}`);
  if (os === 'win32') {
    const wddm = await run(powershellExe(), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WDDM_COUNTER_SCRIPT,
    ]);
    const devices = wddm.ok ? parseWddmCounters(wddm.stdout) : undefined;
    if (devices) return { value: { source: 'wddm-counters', devices, unified: false } };
    // Пустой ответ счётчика — чаще всего локализованные имена: числа нет, подбор по оценке.
    tried.push(
      `wddm counters: ${wddm.ok ? 'no samples (localized or missing counters)' : wddm.reason}`,
    );
    return { unknown: tried.join('; ') };
  }
  const rocm = await run('rocm-smi', ROCM_SMI_ARGS);
  const devices = rocm.ok ? parseRocmSmi(rocm.stdout) : undefined;
  if (devices) return { value: { source: 'rocm-smi', devices, unified: false } };
  tried.push(`rocm-smi: ${rocm.ok ? 'unparsed output' : rocm.reason}`);
  return { unknown: tried.join('; ') };
}

/** ОЗУ машины — подбор без карты (CPU) и на объединённой памяти. */
export function readRamMemory(): { totalBytes: number; freeBytes: number } {
  return { totalBytes: totalmem(), freeBytes: freemem() };
}
