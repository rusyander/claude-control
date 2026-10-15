import type { RunCommand } from './hardware.ts';

/**
 * Сколько видеопамяти держит процесс сервера НА ДЕЛЕ и сколько свободно у драйвера (L9,
 * 15.10). Подбор при загруженном сервере ошибался дважды:
 * - «свободно» брал у `llama-server --list-devices`, а CUDA под WDDM считает память
 *   нашего же сервера свободной (замер: 21,2 ГиБ «free» при 0,8 у nvidia-smi);
 * - сверху засчитывал серверу свою оценку запуска (23,2 ГиБ при 131072 и q8_0).
 * Итог упирался в объём карты, подбор оставлял q8_0, процесс держал на карте 21,3 ГиБ и
 * ещё 1,4 вытеснял в общую память — генерация 0,6 ток/с.
 *
 * Источники:
 * - процесс на Windows (WDDM): счётчик `\GPU Process Memory(pid_N_*)\{Dedicated,Shared}
 *   Usage` — `nvidia-smi` под WDDM по процессам пишет `[N/A]`; на локализованной Windows
 *   имена счётчиков другие — тогда замера нет, и подбор считает по оценке, как раньше;
 * - процесс на остальных с NVIDIA: `nvidia-smi --query-compute-apps`; вытеснения там не
 *   бывает — нехватка памяти кончается отказом загрузки;
 * - свободное: `nvidia-smi --query-gpu=memory.free` — число драйвера, с его собственным
 *   резервом (на 4090 ~0,4 ГиБ, которых нет ни в одном счётчике); без NVIDIA на Windows —
 *   занятое адаптером по счётчику `\GPU Adapter Memory(*)\Dedicated Usage`.
 */

export interface ProcessVram {
  /** На карте. */
  dedicatedBytes: number;
  /** Вытеснено в общую (системную) память — признак того, что запуск не влез. */
  sharedBytes: number;
  /** Свободно на карте по драйверу (`nvidia-smi`). */
  freeBytes?: number;
  /** Занято на адаптере всеми процессами (счётчик Windows) — когда драйвер свободное не сказал. */
  adapterUsedBytes?: number;
}

/**
 * Вытеснение, при котором запуск считается не влезшим. Сервер на карте целиком держит в
 * общей памяти лишь закреплённые буферы обмена: замер 15.10, Qwen3.8 при 131072 — q4_0
 * целиком на карте 0,39 ГиБ (81 ток/с), q8_0 с вытеснением 1,4–1,6 ГиБ (0,6 ток/с).
 */
export const SPILL_BYTES = 768 * 1024 ** 2;

const MIB = 1024 ** 2;

const counterScript = (pid: number): string => {
  const paths = [
    `\\GPU Process Memory(pid_${pid}_*)\\Dedicated Usage`,
    `\\GPU Process Memory(pid_${pid}_*)\\Shared Usage`,
    '\\GPU Adapter Memory(*)\\Dedicated Usage',
  ];
  const list = paths.map((path) => `'${path}'`).join(',');
  return `(Get-Counter ${list} -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object { $_.Path + '=' + [int64]$_.CookedValue }`;
};

/**
 * Разбор вывода счётчиков: по строке `путь=байты`. Процесс может значиться на нескольких
 * адаптерах (встроенная графика); берётся тот, где на карте больше всего, с вытеснением и
 * занятым того же адаптера.
 */
export function parseGpuCounters(out: string): ProcessVram | undefined {
  const byAdapter = new Map<string, ProcessVram>();
  const adapterUsed = new Map<string, number>();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    const own = /\(pid_\d+_(luid_[^)]+)\)\\(dedicated|shared) usage=(\d+)/i.exec(line);
    if (own) {
      const [, adapter = '', kind = '', bytes = '0'] = own;
      const entry = byAdapter.get(adapter) ?? { dedicatedBytes: 0, sharedBytes: 0 };
      if (kind.toLowerCase() === 'dedicated') entry.dedicatedBytes = Number(bytes);
      else entry.sharedBytes = Number(bytes);
      byAdapter.set(adapter, entry);
      continue;
    }
    const adapter = /adapter memory\((luid_[^)]+)\)\\dedicated usage=(\d+)/i.exec(line);
    if (adapter) adapterUsed.set(adapter[1] ?? '', Number(adapter[2]));
  }
  let best: [string, ProcessVram] | undefined;
  for (const entry of byAdapter)
    if (!best || entry[1].dedicatedBytes > best[1].dedicatedBytes) best = entry;
  if (!best || best[1].dedicatedBytes <= 0) return undefined;
  const used = adapterUsed.get(best[0]);
  return used === undefined ? best[1] : { ...best[1], adapterUsedBytes: used };
}

/** Вывод `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits` (МиБ). */
export function parseComputeApps(out: string, pid: number): ProcessVram | undefined {
  for (const line of out.split(/\r?\n/)) {
    const [owner, used] = line.split(',').map((cell) => cell.trim());
    if (Number(owner) !== pid || !used || !/^\d+$/.test(used)) continue;
    return { dedicatedBytes: Number(used) * MIB, sharedBytes: 0 };
  }
  return undefined;
}

/** Первая строка `nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits` (МиБ). */
export function parseDriverFree(out: string): number | undefined {
  const first = out.split(/\r?\n/)[0]?.trim() ?? '';
  return /^\d+$/.test(first) ? Number(first) * MIB : undefined;
}

async function driverFree(run: RunCommand): Promise<number | undefined> {
  try {
    return parseDriverFree(
      await run('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits']),
    );
  } catch {
    return undefined;
  }
}

export async function processVram(
  run: RunCommand,
  os: NodeJS.Platform,
  pid: number,
): Promise<ProcessVram | undefined> {
  let own: ProcessVram | undefined;
  try {
    own =
      os === 'win32'
        ? parseGpuCounters(
            await run('powershell.exe', [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              counterScript(pid),
            ]),
          )
        : parseComputeApps(
            await run('nvidia-smi', [
              '--query-compute-apps=pid,used_memory',
              '--format=csv,noheader,nounits',
            ]),
            pid,
          );
  } catch {
    // Нет утилиты, нет счётчика — подбор считает по оценке, как до замера.
    return undefined;
  }
  if (!own) return undefined;
  const free = await driverFree(run);
  return free === undefined ? own : { ...own, freeBytes: free };
}
