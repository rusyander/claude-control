import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseDarwinMemory,
  parseNvidiaSmi,
  parseRocmSmi,
  parseWddmCounters,
  readGpuMemory,
  type GpuTool,
} from './gpu.ts';
import { currentOs } from './os-kind.ts';
import type { ToolRun } from './run-tool.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/gpu/${name}`, import.meta.url), 'utf8');

const ok = (stdout: string): ToolRun => ({
  ok: true,
  code: 0,
  stdout,
  stderr: '',
  timedOut: false,
});
const missing = (tool: string): ToolRun => ({
  ok: false,
  reason: `ENOENT: spawn ${tool}`,
  timedOut: false,
});

/** Подставной запуск: ответ по имени инструмента (первое слово файла без пути). */
function tools(answers: Record<string, ToolRun>): { run: GpuTool; calls: string[] } {
  const calls: string[] = [];
  const run: GpuTool = async (file) => {
    const name =
      /[^\\/]+$/
        .exec(file)?.[0]
        ?.replace(/\.exe$/i, '')
        .toLowerCase() ?? file;
    calls.push(name);
    return answers[name] ?? missing(name);
  };
  return { run, calls };
}

const GIB = 1024 ** 3;

describe('P129 GPU memory read per OS over recorded outputs', () => {
  it('P129 parsers: nvidia-smi (Windows, Linux 2 GPUs), WDDM counters, rocm-smi, macOS sysctl + vm_stat', () => {
    expect(parseNvidiaSmi(fixture('nvidia-smi-win.csv'))).toEqual([
      {
        id: '0',
        name: 'NVIDIA GeForce RTX 4090',
        totalBytes: 24564 * 1024 ** 2,
        usedBytes: 3226 * 1024 ** 2,
        freeBytes: 20913 * 1024 ** 2,
      },
    ]);
    expect(parseNvidiaSmi(fixture('nvidia-smi-linux-2gpu.csv'))?.map((d) => d.usedBytes)).toEqual([
      0,
      17012 * 1024 ** 2,
    ]);
    expect(parseWddmCounters(fixture('wddm-counters.txt'))?.map((d) => d.usedBytes)).toEqual([
      3393007616, 0, 316264448,
    ]);
    expect(parseWddmCounters(fixture('wddm-localized.txt'))).toBeUndefined();
    expect(parseRocmSmi(fixture('rocm-smi.json'))).toEqual([
      { id: '0', totalBytes: 17163091968, usedBytes: 10964992, freeBytes: 17163091968 - 10964992 },
    ]);
    const mac = parseDarwinMemory(fixture('darwin-memsize.txt'), fixture('darwin-vm_stat.txt'));
    expect(mac?.[0]?.totalBytes).toBe(32 * GIB);
    expect(mac?.[0]?.freeBytes).toBe((81234 + 598765 + 12345) * 16384);
    // Негодный вывод — нет числа, а не ноль.
    expect(parseNvidiaSmi('0, X, [N/A], 1, 2')).toBeUndefined();
    expect(parseNvidiaSmi('')).toBeUndefined();
    expect(parseRocmSmi('not json')).toBeUndefined();
    expect(parseRocmSmi('{"card0": {"VRAM Total Memory (B)": "x"}}')).toBeUndefined();
    expect(parseDarwinMemory('abc', fixture('darwin-vm_stat.txt'))).toBeUndefined();
  });

  it('P129 source order: Windows nvidia-smi, else WDDM counters; localized counters → unknown named, never absent', async () => {
    const nv = tools({ 'nvidia-smi': ok(fixture('nvidia-smi-win.csv')) });
    const viaNvidia = await readGpuMemory('win32', nv.run);
    expect(viaNvidia).toMatchObject({ value: { source: 'nvidia-smi', unified: false } });
    expect(nv.calls).toEqual(['nvidia-smi']);

    const wddm = tools({ powershell: ok(fixture('wddm-counters.txt')) });
    const viaCounters = await readGpuMemory('win32', wddm.run);
    expect(viaCounters).toMatchObject({ value: { source: 'wddm-counters' } });
    expect(wddm.calls).toEqual(['nvidia-smi', 'powershell']);

    const localized = await readGpuMemory(
      'win32',
      tools({ powershell: ok(fixture('wddm-localized.txt')) }).run,
    );
    expect(localized).toEqual({
      unknown: expect.stringMatching(/nvidia-smi: ENOENT.*localized or missing counters/),
    });
  });

  it('P129 source order: Linux nvidia-smi garbage → rocm-smi; nothing → unknown; macOS → unified memory', async () => {
    const amd = tools({
      'nvidia-smi': ok('NVIDIA-SMI has failed because it could not communicate with the driver'),
      'rocm-smi': ok(fixture('rocm-smi.json')),
    });
    expect(await readGpuMemory('linux', amd.run)).toMatchObject({ value: { source: 'rocm-smi' } });
    const none = await readGpuMemory('linux', tools({}).run);
    expect(none).toEqual({
      unknown: expect.stringMatching(/nvidia-smi: ENOENT.*rocm-smi: ENOENT/),
    });
    const mac = await readGpuMemory(
      'darwin',
      tools({
        sysctl: ok(fixture('darwin-memsize.txt')),
        vm_stat: ok(fixture('darwin-vm_stat.txt')),
      }).run,
    );
    expect(mac).toMatchObject({ value: { source: 'unified-memory', unified: true } });
    expect(await readGpuMemory('darwin', tools({}).run)).toHaveProperty('unknown');
  });

  it.runIf(currentOs() === 'win32')(
    'P129 live Windows: this machine answers with a value from a named source',
    async () => {
      const fact = await readGpuMemory();
      if (!('value' in fact)) throw new Error(`live GPU read unknown: ${JSON.stringify(fact)}`);
      expect(['nvidia-smi', 'wddm-counters']).toContain(fact.value.source);
      expect(fact.value.devices.length).toBeGreaterThan(0);
      expect(fact.value.devices.every((d) => d.usedBytes >= 0)).toBe(true);
    },
  );
});
