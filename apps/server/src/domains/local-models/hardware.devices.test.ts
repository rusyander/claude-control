import { describe, it, expect } from 'vitest';
import type { GpuSpec } from '@agentdeck/contracts/local-models';
import { detectGpus, parseLlamaDevices, parseNvidiaSmi, readAmdSysfs } from './hardware.ts';

// Подбор модели не должен знать только NVIDIA: у человека может быть Radeon, Mac,
// DGX Spark или Ryzen AI Max — каждый путь проверяется своим выводом.
const table: GpuSpec[] = [
  { name: 'RTX 4090', vendor: 'nvidia', vramGb: 24, bandwidthGbs: 1008 },
  { name: 'RX 7900 XTX', vendor: 'amd', vramGb: 24, bandwidthGbs: 960 },
];
const GB = 1024 ** 3;

describe('parseLlamaDevices — устройства глазами самой llama.cpp', () => {
  it('разбирает CUDA, Vulkan, Metal и SYCL, пропуская RPC', () => {
    const gpus = parseLlamaDevices(
      [
        'Available devices:',
        '  CUDA0: NVIDIA GeForce RTX 4090 (24563 MiB, 23036 MiB free)',
        '  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 24000 MiB free)',
        '  MTL0: Apple M3 Max (98304 MiB, 98303 MiB free)',
        '  SYCL0: Intel(R) Arc(TM) A770 Graphics (16225 MiB, 16000 MiB free)',
        '  RPC0: 192.168.1.5:50052 (8192 MiB, 8192 MiB free)',
      ].join('\n'),
      table,
    );
    expect(gpus.map((gpu) => [gpu.vendor, gpu.vramGb, gpu.freeGb, gpu.unified ?? false])).toEqual([
      ['nvidia', 24, 22.5, false],
      ['amd', 24, 23.4, false],
      ['apple', 96, 96, true],
      ['intel', 15.8, 15.6, false],
    ]);
    expect(gpus[0]?.bandwidthFrom).toBe('table');
    expect(gpus[1]?.bandwidthGbs).toBe(960);
  });

  it('Ryzen AI Max+ 395 через Vulkan — общая память', () => {
    const [gpu] = parseLlamaDevices(
      '  Vulkan0: AMD Radeon 8060S Graphics (98304 MiB, 97000 MiB free)',
      table,
    );
    expect(gpu).toMatchObject({ vendor: 'amd', unified: true, vramGb: 96 });
  });

  it('detectGpus спрашивает llama.cpp первой и не зовёт nvidia-smi', async () => {
    const calls: string[] = [];
    const run = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === '/rt/llama-server')
        return '  Vulkan0: AMD Radeon RX 7900 XTX (24560 MiB, 24000 MiB free)';
      throw new Error('нет такой программы');
    };
    const found = await detectGpus({
      run,
      platform: 'linux',
      table,
      llamaServer: '/rt/llama-server',
    });
    expect(found.detectedBy).toBe('llama.cpp');
    expect(calls).toEqual(['/rt/llama-server']);
  });

  it('пустой ответ llama.cpp — дальше по драйверам, а не «карты нет»', async () => {
    const run = async (cmd: string) => {
      if (cmd === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24564, 21000';
      return 'Available devices:\n';
    };
    const found = await detectGpus({
      run,
      platform: 'win32',
      table,
      llamaServer: 'C:/rt/llama-server.exe',
    });
    expect(found.detectedBy).toBe('nvidia-smi');
  });
});

describe('общая память у NVIDIA (DGX Spark, Jetson)', () => {
  it('«[N/A]» вместо памяти у GB10 — объём из ОЗУ, а не пропуск карты', () => {
    const gpus = parseNvidiaSmi('NVIDIA GB10, [N/A], [N/A]', table, 128 * GB);
    expect(gpus).toEqual([
      expect.objectContaining({ vendor: 'nvidia', unified: true, vramGb: 128 }),
    ]);
  });

  it('«[N/A]» у неизвестной карты по-прежнему не выдумывает память', () => {
    expect(parseNvidiaSmi('Some Virtual GPU, [N/A], [N/A]', table, 64 * GB)).toEqual([]);
  });
});

describe('readAmdSysfs — Radeon на Linux без ROCm', () => {
  const files = (map: Record<string, string>) => (path: string) => map[path];

  it('дискретная карта — выделенная память и свободная', () => {
    const gpus = readAmdSysfs(
      ['/sys/class/drm/card1'],
      files({
        '/sys/class/drm/card1/device/vendor': '0x1002\n',
        '/sys/class/drm/card1/device/mem_info_vram_total': String(24 * GB),
        '/sys/class/drm/card1/device/mem_info_vram_used': String(2 * GB),
        '/sys/class/drm/card1/device/mem_info_gtt_total': String(32 * GB),
        '/sys/class/drm/card1/device/product_name': 'Radeon RX 7900 XTX',
      }),
      table,
    );
    expect(gpus).toEqual([
      expect.objectContaining({ vendor: 'amd', vramGb: 24, freeGb: 22, bandwidthFrom: 'table' }),
    ]);
  });

  it('встроенный чип с большой GTT — общая память по GTT', () => {
    const gpus = readAmdSysfs(
      ['/sys/class/drm/card0'],
      files({
        '/sys/class/drm/card0/device/vendor': '0x1002',
        '/sys/class/drm/card0/device/mem_info_vram_total': String(0.5 * GB),
        '/sys/class/drm/card0/device/mem_info_gtt_total': String(96 * GB),
      }),
      table,
    );
    expect(gpus).toEqual([expect.objectContaining({ unified: true, vramGb: 96 })]);
  });

  it('карта NVIDIA в sysfs не принимается за Radeon', () => {
    // Память у карты есть — отсечь её должна именно проверка производителя.
    const read = files({
      '/sys/class/drm/card0/device/vendor': '0x10de',
      '/sys/class/drm/card0/device/mem_info_vram_total': String(24 * GB),
    });
    expect(readAmdSysfs(['/sys/class/drm/card0'], read, table)).toEqual([]);
  });

  it('detectGpus на Linux без rocm-smi доходит до sysfs', async () => {
    const run = async () => {
      throw new Error('нет');
    };
    const found = await detectGpus({
      run,
      platform: 'linux',
      table,
      listDrmCards: () => ['/sys/class/drm/card1'],
      readSysfs: files({
        '/sys/class/drm/card1/device/vendor': '0x1002',
        '/sys/class/drm/card1/device/mem_info_vram_total': String(16 * GB),
        '/sys/class/drm/card1/device/mem_info_vram_used': '0',
      }),
    });
    expect(found).toMatchObject({ detectedBy: 'sysfs', gpus: [{ vramGb: 16 }] });
  });
});
