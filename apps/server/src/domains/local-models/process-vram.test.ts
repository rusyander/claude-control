import { describe, it, expect } from 'vitest';
import {
  SPILL_BYTES,
  parseComputeApps,
  parseDriverFree,
  parseGpuCounters,
  processVram,
} from './process-vram.ts';

/**
 * Замер памяти процесса сервера (L9). Вывод счётчика — снятый с настоящей машины 15.10
 * этой же командой: Qwen3.8 при 131072 и q8_0, 21,3 ГиБ на карте и 1,4 в общей памяти.
 */

const SPILLING =
  '\\\\rusyander\\gpu process memory(pid_52348_luid_0x00000000_0x00017d79_phys_0)\\dedicated usage=22847451136\r\n' +
  '\\\\rusyander\\gpu process memory(pid_52348_luid_0x00000000_0x00017d79_phys_0)\\shared usage=1526726656\r\n';

describe('счётчик GPU Process Memory (Windows)', () => {
  it('настоящий вывод: на карте и вытеснено — по отдельности; вытеснение выше порога', () => {
    const measured = parseGpuCounters(SPILLING);
    expect(measured).toEqual({ dedicatedBytes: 22_847_451_136, sharedBytes: 1_526_726_656 });
    expect((measured?.sharedBytes ?? 0) > SPILL_BYTES).toBe(true);
  });

  it('занятое адаптером — того же адаптера, что и процесс (живой вывод 15.10, три адаптера)', () => {
    const out =
      SPILLING +
      '\\\\rusyander\\gpu adapter memory(luid_0x00000000_0x00017d79_phys_0)\\dedicated usage=24462512128\r\n' +
      '\\\\rusyander\\gpu adapter memory(luid_0x00000000_0x0001be5d_phys_0)\\dedicated usage=0\r\n' +
      '\\\\rusyander\\gpu adapter memory(luid_0x00000000_0x0001bee5_phys_0)\\dedicated usage=266776576\r\n';
    expect(parseGpuCounters(out)?.adapterUsedBytes).toBe(24_462_512_128);
  });

  it('процесс на двух адаптерах — берётся тот, где на карте больше, с его же вытеснением', () => {
    const out =
      '\\\\h\\gpu process memory(pid_7_luid_0x0_0x1_phys_0)\\dedicated usage=104857600\n' +
      '\\\\h\\gpu process memory(pid_7_luid_0x0_0x1_phys_0)\\shared usage=9999999999\n' +
      '\\\\h\\gpu process memory(pid_7_luid_0x0_0x2_phys_0)\\dedicated usage=20000000000\n' +
      '\\\\h\\gpu process memory(pid_7_luid_0x0_0x2_phys_0)\\shared usage=1000\n';
    expect(parseGpuCounters(out)).toEqual({ dedicatedBytes: 20_000_000_000, sharedBytes: 1000 });
  });

  it('пусто или чужой язык счётчиков — замера нет, подбор остаётся на оценке', () => {
    expect(parseGpuCounters('')).toBeUndefined();
    expect(
      parseGpuCounters('\\\\h\\память графического процессора(pid_7_luid_0x0)\\выделено=1\n'),
    ).toBeUndefined();
  });
});

describe('nvidia-smi по процессам (не Windows)', () => {
  it('строка своего процесса — МиБ в байты, вытеснения не бывает', () => {
    expect(parseComputeApps('111, 500\n4242, 21000\n', 4242)).toEqual({
      dedicatedBytes: 21_000 * 1024 ** 2,
      sharedBytes: 0,
    });
  });

  it('своего процесса нет или память [N/A] — замера нет', () => {
    expect(parseComputeApps('111, 500\n', 4242)).toBeUndefined();
    expect(parseComputeApps('4242, [N/A]\n', 4242)).toBeUndefined();
  });
});

describe('processVram', () => {
  it('Windows спрашивает счётчик своего процесса, остальные — nvidia-smi; свободное — у драйвера', async () => {
    const calls: string[] = [];
    const run = (cmd: string, args: string[]): Promise<string> => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (args.includes('--query-gpu=memory.free')) return Promise.resolve('823\n');
      return Promise.resolve(cmd === 'nvidia-smi' ? '52348, 100\n' : SPILLING);
    };
    expect(await processVram(run, 'win32', 52348)).toEqual({
      dedicatedBytes: 22_847_451_136,
      sharedBytes: 1_526_726_656,
      freeBytes: 823 * 1024 ** 2,
    });
    expect(calls[0]).toContain('pid_52348_*');
    expect((await processVram(run, 'linux', 52348))?.dedicatedBytes).toBe(100 * 1024 ** 2);
  });

  it('nvidia-smi нет — замер процесса остаётся, свободного по драйверу нет', async () => {
    const run = (cmd: string): Promise<string> =>
      cmd === 'nvidia-smi' ? Promise.reject(new Error('ENOENT')) : Promise.resolve(SPILLING);
    expect(await processVram(run, 'win32', 52348)).toEqual({
      dedicatedBytes: 22_847_451_136,
      sharedBytes: 1_526_726_656,
    });
    expect(parseDriverFree('[N/A]\n')).toBeUndefined();
  });

  it('утилита упала — замера нет, исключение не выходит наружу', async () => {
    const run = (): Promise<string> => Promise.reject(new Error('no powershell'));
    expect(await processVram(run, 'win32', 1)).toBeUndefined();
  });
});
