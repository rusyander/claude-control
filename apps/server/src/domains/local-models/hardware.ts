import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { arch, platform, totalmem } from 'node:os';
import type {
  GpuSpec,
  GpuVendor,
  HardwareGpu,
  HardwareInfo,
} from '@agentdeck/contracts/local-models';

/**
 * Что за видеокарта и сколько у неё памяти.
 *
 * Спрашиваем драйвер, а не угадываем по названию: у одной и той же модели карты
 * бывает разная память (RTX 4060 Ti на 8 и на 16 ГБ), а свободную память знает
 * только драйвер — рабочий стол и браузер держат свою долю. Справочник нужен ради
 * ПРОПУСКНОЙ СПОСОБНОСТИ: её драйвер не отдаёт, а скорость генерации задаёт она.
 */

export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

/** Запуск с пределом времени: зависший драйвер не должен вешать раздел. */
export const runCommand: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });

export interface HardwareDeps {
  run?: RunCommand;
  platform?: NodeJS.Platform;
  totalMemBytes?: number;
  /** Каталог, под которым меряется свободное место. */
  root?: string;
  table: GpuSpec[];
  /**
   * Путь к своему `llama-server`. Есть — устройства спрашиваем у него первым: он
   * видит ровно то, на чём потом запустит модель (CUDA, ROCm, Vulkan, Metal, SYCL),
   * у любого производителя, без утилит драйвера.
   */
  llamaServer?: string;
  /** Чтение файла sysfs (Linux); пусто — файла нет. Подменяется в тестах. */
  readSysfs?: (path: string) => string | undefined;
  /** Каталоги `/sys/class/drm/card*`; подменяется в тестах. */
  listDrmCards?: () => string[];
}

/** «NVIDIA GeForce RTX 4070 Ti SUPER» → «rtx 4070 ti super»: без производителя и марки. */
export function normalizeGpuName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(r\)|\(tm\)/g, ' ')
    .replace(/\b(nvidia|geforce|amd|radeon\(tm\)|intel|apple|graphics|laptop gpu|gpu)\b/g, ' ')
    .replace(/\bradeon\b(?=\s+(rx|pro|ai))/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Строка справочника для названия из драйвера. Побеждает САМОЕ ДЛИННОЕ совпадение
 * по границам слов: «RX 7900 XTX» не должна достаться строке «RX 7900 XT», а
 * «RTX 4070 Ti Super» — строке «RTX 4070».
 */
export function matchGpuSpec(raw: string, table: GpuSpec[]): GpuSpec | undefined {
  const name = ` ${normalizeGpuName(raw)} `;
  let best: GpuSpec | undefined;
  for (const spec of table) {
    const key = ` ${normalizeGpuName(spec.name)} `;
    if (name.includes(key) && (!best || key.length > normalizeGpuName(best.name).length + 2)) {
      best = spec;
    }
  }
  return best;
}

/** Прикидка пропускной способности неизвестной карты — по памяти, грубо и с меткой «оценка». */
export function guessBandwidth(vendor: GpuVendor, vramGb: number): number {
  if (vendor === 'apple') return 200;
  if (vendor === 'cpu') return 60;
  if (vramGb <= 8) return 300;
  if (vramGb <= 12) return 450;
  if (vramGb <= 16) return 600;
  return 900;
}

/** «Apple M4 Pro» → поколение 4, уровень pro; базовый чип — уровень base. */
function appleChip(name: string): { gen: number; tier: string } | undefined {
  const match = /\bM(\d+)(?:\s+(Pro|Max|Ultra))?\b/i.exec(name);
  if (!match) return undefined;
  return { gen: Number(match[1]), tier: (match[2] ?? 'base').toLowerCase() };
}

/**
 * Чип Apple — по поколению И уровню. Общее «самое длинное совпадение» отдавало
 * «M5 Pro», которого нет в справочнике, строке базового M5 с пометкой «из
 * справочника», хотя у Pro память вдвое быстрее. Нет точной строки (новый чип:
 * M5 Max, M6, M7) — новейшее известное поколение того же уровня, как прикидка:
 * поколения растут, и это нижняя, а не выдуманная оценка.
 */
export function appleBandwidth(
  name: string,
  table: GpuSpec[],
): { bandwidthGbs: number; bandwidthFrom: HardwareGpu['bandwidthFrom'] } | undefined {
  const chip = appleChip(name);
  if (!chip) return undefined;
  const known = table
    .filter((spec) => spec.vendor === 'apple')
    .map((spec) => ({ spec, chip: appleChip(spec.name) }))
    .filter((entry) => entry.chip?.tier === chip.tier);
  const exact = known.find((entry) => entry.chip?.gen === chip.gen);
  if (exact) return { bandwidthGbs: exact.spec.bandwidthGbs, bandwidthFrom: 'table' };
  const older = known
    .filter((entry) => (entry.chip?.gen ?? 0) < chip.gen)
    .sort((x, y) => (y.chip?.gen ?? 0) - (x.chip?.gen ?? 0))[0];
  return older ? { bandwidthGbs: older.spec.bandwidthGbs, bandwidthFrom: 'guess' } : undefined;
}

function withBandwidth(
  base: Omit<HardwareGpu, 'bandwidthGbs' | 'bandwidthFrom'>,
  table: GpuSpec[],
): HardwareGpu {
  if (base.vendor === 'apple') {
    const apple = appleBandwidth(base.name, table);
    if (apple) return { ...base, ...apple };
  }
  const spec = matchGpuSpec(base.name, table);
  // У ноутбучной версии та же марка, но память медленнее — примерно на четверть.
  const laptop = /laptop|mobile|max-q/i.test(base.name) ? 0.75 : 1;
  if (spec)
    return {
      ...base,
      bandwidthGbs: Math.round(spec.bandwidthGbs * laptop),
      bandwidthFrom: 'table',
    };
  return {
    ...base,
    bandwidthGbs: guessBandwidth(base.vendor, base.vramGb),
    bandwidthFrom: 'guess',
  };
}

/**
 * Чипы с общей с процессором памятью: Apple, NVIDIA GB10 (DGX Spark) и Jetson,
 * AMD Strix Halo / Strix Point (Ryzen AI Max+ 395, Radeon 8060S/890M). Своей
 * видеопамяти у них нет — модели доступна часть ОЗУ, и считать надо от неё.
 */
const UNIFIED_NAME = /\b(gb10|gb200|jetson|orin|thor|8060s|8050s|890m|880m|ryzen ai|strix)\b/i;

/** Вывод `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(
  text: string,
  table: GpuSpec[],
  totalMemBytes = totalmem(),
): HardwareGpu[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(',').map((part) => part.trim()))
    .filter((parts) => parts.length >= 3 && parts[0])
    .flatMap(([name = '', total = '0', free = '0']) => {
      // GB10 и Jetson отдают память как «[N/A]»: она общая, и объём — это ОЗУ.
      // Раньше такая строка отбрасывалась, и DGX Spark выглядел машиной без карты.
      if (!(Number(total) > 0)) {
        if (!UNIFIED_NAME.test(name)) return [];
        return [
          withBandwidth(
            { vendor: 'nvidia', name, vramGb: round1(totalMemBytes / 1024 ** 3), unified: true },
            table,
          ),
        ];
      }
      return [
        withBandwidth(
          {
            vendor: 'nvidia',
            name,
            vramGb: round1(Number(total) / 1024),
            freeGb: round1(Number(free) / 1024),
          },
          table,
        ),
      ];
    });
}

/**
 * Вывод `llama-server --list-devices`:
 * `  CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, 23036 MiB free)`,
 * `  Vulkan0: AMD Radeon RX 7900 XTX (…)`, `  MTL0: Apple M3 Max (…)`, `  SYCL0: Intel Arc …`.
 * Производитель — по движку, а у Vulkan (он у всех) — по названию.
 */
export function parseLlamaDevices(text: string, table: GpuSpec[]): HardwareGpu[] {
  const gpus: HardwareGpu[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z]+)\d+:\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/.exec(line);
    if (!match) continue;
    const [, backend = '', name = '', total = '0', free = '0'] = match;
    const kind = backend.toUpperCase();
    // Удалённые узлы (RPC) и процессор картой не считаются.
    if (kind === 'RPC' || kind === 'CPU' || !(Number(total) > 0)) continue;
    const vendor: GpuVendor =
      kind === 'MTL' || kind === 'METAL'
        ? 'apple'
        : kind === 'CUDA'
          ? 'nvidia'
          : kind === 'ROCM' || kind === 'HIP'
            ? 'amd'
            : kind === 'SYCL'
              ? 'intel'
              : vendorOf(name);
    const unified = vendor === 'apple' || UNIFIED_NAME.test(name);
    gpus.push(
      withBandwidth(
        {
          vendor,
          name,
          vramGb: round1(Number(total) / 1024),
          freeGb: round1(Number(free) / 1024),
          ...(unified ? { unified: true } : {}),
        },
        table,
      ),
    );
  }
  return gpus;
}

/**
 * Карты amdgpu на Linux через sysfs — без ROCm (у многих стоит только Mesa).
 * Встроенный чип с крошечной выделенной памятью, но большой GTT (Strix Halo) —
 * общая память: модели доступна GTT.
 */
export function readAmdSysfs(
  cards: string[],
  read: (path: string) => string | undefined,
  table: GpuSpec[],
): HardwareGpu[] {
  const gpus: HardwareGpu[] = [];
  for (const card of cards) {
    const dev = `${card}/device`;
    if (read(`${dev}/vendor`)?.trim() !== '0x1002') continue;
    const vram = Number(read(`${dev}/mem_info_vram_total`) ?? 0);
    const used = Number(read(`${dev}/mem_info_vram_used`) ?? 0);
    const gtt = Number(read(`${dev}/mem_info_gtt_total`) ?? 0);
    const name = read(`${dev}/product_name`)?.trim() || 'AMD GPU';
    const apu = vram < 4 * 1024 ** 3 && gtt > vram;
    const total = apu ? gtt : vram;
    if (total < 2 * 1024 ** 3) continue;
    gpus.push(
      withBandwidth(
        {
          vendor: 'amd',
          name,
          vramGb: round1(total / 1024 ** 3),
          ...(apu ? { unified: true } : { freeGb: round1((vram - used) / 1024 ** 3) }),
        },
        table,
      ),
    );
  }
  return gpus;
}

function readSysfsFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function listDrmCards(): string[] {
  try {
    return readdirSync('/sys/class/drm')
      .filter((name) => /^card\d+$/.test(name))
      .map((name) => `/sys/class/drm/${name}`);
  } catch {
    return [];
  }
}

/**
 * Видеоадаптеры Windows из реестра: `HardwareInformation.qwMemorySize` — честный
 * 64-битный объём. `Win32_VideoController.AdapterRAM` для этого не годится: он
 * 32-битный и у любой карты больше 4 ГБ показывает 4.
 */
export function parseWindowsAdapters(json: string, table: GpuSpec[]): HardwareGpu[] {
  const raw: unknown = JSON.parse(json || '[]');
  const rows = (Array.isArray(raw) ? raw : [raw]) as Record<string, unknown>[];
  const gpus: HardwareGpu[] = [];
  for (const row of rows) {
    const name = String(row.DriverDesc ?? '').trim();
    const bytes = Number(row['HardwareInformation.qwMemorySize'] ?? 0);
    if (!name || !(bytes > 0)) continue;
    const vendor = vendorOf(name);
    // Встроенная графика Intel/AMD с «памятью» из ОЗУ модели не потянет — её не считаем.
    if (bytes < 2 * 1024 ** 3) continue;
    gpus.push(withBandwidth({ vendor, name, vramGb: round1(bytes / 1024 ** 3) }, table));
  }
  return gpus;
}

function vendorOf(name: string): GpuVendor {
  if (/nvidia/i.test(name)) return 'nvidia';
  if (/amd|radeon/i.test(name)) return 'amd';
  if (/intel|arc/i.test(name)) return 'intel';
  return 'cpu';
}

/** `rocm-smi --showproductname --showmeminfo vram --json`. */
export function parseRocmSmi(json: string, table: GpuSpec[]): HardwareGpu[] {
  const raw = JSON.parse(json || '{}') as Record<string, Record<string, string>>;
  return Object.values(raw)
    .map((card) => {
      const total = Number(card['VRAM Total Memory (B)'] ?? 0);
      const used = Number(card['VRAM Total Used Memory (B)'] ?? 0);
      const name = String(
        card['Card Series'] ?? card['Card series'] ?? card['Card SKU'] ?? 'AMD GPU',
      );
      return { name, total, used };
    })
    .filter((card) => card.total > 0)
    .map((card) =>
      withBandwidth(
        {
          vendor: 'amd',
          name: card.name,
          vramGb: round1(card.total / 1024 ** 3),
          freeGb: round1((card.total - card.used) / 1024 ** 3),
        },
        table,
      ),
    );
}

/** `sysctl -n machdep.cpu.brand_string hw.memsize` на Mac с Apple Silicon. */
export function parseAppleSysctl(text: string, table: GpuSpec[]): HardwareGpu[] {
  const [brand = '', mem = '0'] = text.split(/\r?\n/).map((line) => line.trim());
  if (!/apple/i.test(brand)) return [];
  return [
    withBandwidth(
      { vendor: 'apple', name: brand, vramGb: round1(Number(mem) / 1024 ** 3), unified: true },
      table,
    ),
  ];
}

const WINDOWS_ADAPTERS =
  "Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' " +
  "-ErrorAction SilentlyContinue | Select-Object DriverDesc,'HardwareInformation.qwMemorySize' | ConvertTo-Json -Compress";

async function tryRun(run: RunCommand, cmd: string, args: string[]): Promise<string | undefined> {
  try {
    return await run(cmd, args);
  } catch {
    return undefined;
  }
}

/**
 * Видеокарты по очереди способов: своя llama.cpp (любой производитель) → NVIDIA →
 * платформенный → sysfs amdgpu → пусто (ручной выбор). Утилиты драйвера нужны,
 * пока сборка не скачана: подбор модели идёт до первой загрузки.
 */
export async function detectGpus(
  deps: HardwareDeps,
): Promise<{ gpus: HardwareGpu[]; detectedBy: string }> {
  const run = deps.run ?? runCommand;
  const os = deps.platform ?? platform();
  // Windows (WDDM) вытесняет чужую видеопамять, когда модели она нужна.
  const pageable = os === 'win32' ? { pageable: true } : {};
  if (deps.llamaServer) {
    const out = await tryRun(run, deps.llamaServer, ['--list-devices']);
    const gpus = out ? parseLlamaDevices(out, deps.table) : [];
    if (gpus.length)
      return {
        gpus: gpus.map((gpu) => (gpu.unified ? gpu : { ...gpu, ...pageable })),
        detectedBy: 'llama.cpp',
      };
  }
  const nvidia = await tryRun(run, 'nvidia-smi', [
    '--query-gpu=name,memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ]);
  const fromNvidia = nvidia ? parseNvidiaSmi(nvidia, deps.table, deps.totalMemBytes) : [];
  if (fromNvidia.length)
    return { gpus: fromNvidia.map((gpu) => ({ ...gpu, ...pageable })), detectedBy: 'nvidia-smi' };

  if (os === 'darwin') {
    const out = await tryRun(run, 'sysctl', ['-n', 'machdep.cpu.brand_string', 'hw.memsize']);
    const gpus = out ? parseAppleSysctl(out, deps.table) : [];
    if (gpus.length) return { gpus, detectedBy: 'sysctl' };
  }
  if (os === 'win32') {
    const out = await tryRun(run, 'powershell.exe', ['-NoProfile', '-Command', WINDOWS_ADAPTERS]);
    try {
      const gpus = out ? parseWindowsAdapters(out, deps.table) : [];
      if (gpus.length) return { gpus, detectedBy: 'registry' };
    } catch {
      // Нечитаемый ответ — та же «не определилась», что и пустой.
    }
  }
  if (os === 'linux') {
    const out = await tryRun(run, 'rocm-smi', [
      '--showproductname',
      '--showmeminfo',
      'vram',
      '--json',
    ]);
    try {
      const gpus = out ? parseRocmSmi(out, deps.table) : [];
      if (gpus.length) return { gpus, detectedBy: 'rocm-smi' };
    } catch {
      // То же.
    }
    const cards = (deps.listDrmCards ?? listDrmCards)();
    const gpus = readAmdSysfs(cards, deps.readSysfs ?? readSysfsFile, deps.table);
    if (gpus.length) return { gpus, detectedBy: 'sysfs' };
  }
  return { gpus: [], detectedBy: 'none' };
}

export async function detectHardware(deps: HardwareDeps): Promise<HardwareInfo> {
  const { gpus, detectedBy } = await detectGpus(deps);
  let diskFreeGb: number | undefined;
  if (deps.root) {
    try {
      const stats = await statfs(deps.root);
      diskFreeGb = round1((stats.bavail * stats.bsize) / 1024 ** 3);
    } catch {
      diskFreeGb = undefined;
    }
  }
  return {
    gpus,
    ramGb: round1((deps.totalMemBytes ?? totalmem()) / 1024 ** 3),
    ...(diskFreeGb === undefined ? {} : { diskFreeGb }),
    platform: deps.platform ?? platform(),
    arch: arch(),
    detectedBy,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
