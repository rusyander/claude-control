import { describe, expect, it } from 'vitest';
import type { GpuMemory } from '../../../platform/gpu.ts';
import { decideFit } from './fit.ts';

const GIB = 1024 ** 3;
const ram = { totalBytes: 32 * GIB, freeBytes: 12 * GIB };
const model = { id: 'm', sizeBytes: 4 * GIB };

const nvidia = (devices: GpuMemory['devices']): { value: GpuMemory } => ({
  value: { source: 'nvidia-smi', devices, unified: false },
});

describe('R:PR-04 fit decision — VRAM fact before load', () => {
  it('R:PR-04 fit: measured — fits on the device with most free; short names the gap and RAM; equal need fits', () => {
    const two = nvidia([
      { id: '0', totalBytes: 8 * GIB, usedBytes: 6 * GIB, freeBytes: 2 * GIB },
      { id: '1', totalBytes: 24 * GIB, usedBytes: 3 * GIB, freeBytes: 21 * GIB, name: 'Big' },
    ]);
    expect(decideFit({ model, gpu: two, ram, overheadBytes: GIB })).toMatchObject({
      kind: 'fits',
      basis: 'measured',
      target: 'gpu',
      device: '1',
      needBytes: 5 * GIB,
      freeBytes: 21 * GIB,
      baselineUsedBytes: 9 * GIB,
    });
    const small = nvidia([
      { id: '0', totalBytes: 8 * GIB, usedBytes: 4 * GIB, freeBytes: 4 * GIB },
    ]);
    const short = decideFit({ model, gpu: small, ram, overheadBytes: GIB });
    expect(short).toMatchObject({
      kind: 'short',
      device: '0',
      needBytes: 5 * GIB,
      freeBytes: 4 * GIB,
    });
    expect(short.reasons.join(' ')).toMatch(/short by 1\.00 GiB; ram free 12\.00 GiB/);
    const exact = nvidia([
      { id: '0', totalBytes: 8 * GIB, usedBytes: 3 * GIB, freeBytes: 5 * GIB },
    ]);
    expect(decideFit({ model, gpu: exact, ram, overheadBytes: GIB }).kind).toBe('fits');
  });

  it("fit: the caller's layout need replaces file + overhead; 0 (server fits itself / cpu) loads beside a small card", () => {
    const small = nvidia([
      { id: '0', totalBytes: 8 * GIB, usedBytes: 6 * GIB, freeBytes: 2 * GIB },
    ]);
    // Панель посчитала окно и кеш: нужно 7 ГиБ при файле 4 — свободных 2 не хватит.
    const stated = decideFit({
      model: { ...model, needBytes: 7 * GIB },
      gpu: small,
      ram,
      overheadBytes: GIB,
    });
    expect(stated).toMatchObject({ kind: 'short', needBytes: 7 * GIB });
    // Слои раскладывает сам сервер (`fit = on`) или считает процессор — карте ничего не обещано.
    const spill = decideFit({
      model: { ...model, needBytes: 0 },
      gpu: small,
      ram,
      overheadBytes: GIB,
    });
    expect(spill).toMatchObject({ kind: 'fits', needBytes: 0, baselineUsedBytes: 6 * GIB });
    expect(spill.reasons.join(' ')).toContain('server places layers itself or runs on cpu');
  });

  it('R:PR-04 fit: WDDM (used without capacity) and unknown GPU → estimate, named; unified memory → target unified', () => {
    const wddm = decideFit({
      model,
      gpu: {
        value: {
          source: 'wddm-counters',
          devices: [{ id: 'luid_1', usedBytes: 3 * GIB }],
          unified: false,
        },
      },
      ram,
      overheadBytes: GIB,
    });
    expect(wddm).toMatchObject({ kind: 'fits', basis: 'estimate', baselineUsedBytes: 3 * GIB });
    expect(wddm.reasons[1]).toMatch(/without capacity: loading by estimate/);

    const unknown = decideFit({
      model,
      gpu: { unknown: 'nvidia-smi: ENOENT' },
      ram,
      overheadBytes: GIB,
    });
    expect(unknown).toMatchObject({ kind: 'fits', basis: 'estimate' });
    expect(unknown).not.toHaveProperty('baselineUsedBytes');
    expect(unknown.reasons[1]).toMatch(/unreadable \(nvidia-smi: ENOENT\).*release unverifiable/);
    const absent = decideFit({ model, gpu: { absent: true }, ram, overheadBytes: GIB });
    expect(absent.reasons[1]).toMatch(/no gpu memory source/);

    const mac = decideFit({
      model,
      gpu: {
        value: {
          source: 'unified-memory',
          devices: [
            { id: 'unified', totalBytes: 32 * GIB, usedBytes: 20 * GIB, freeBytes: 12 * GIB },
          ],
          unified: true,
        },
      },
      ram,
      overheadBytes: GIB,
    });
    expect(mac).toMatchObject({ kind: 'fits', target: 'unified', basis: 'measured' });
  });
});
