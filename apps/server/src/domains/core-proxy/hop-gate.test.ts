import { describe, expect, it } from 'vitest';
import type { HopRecordFile } from '../../lib/hop-recorder.mjs';
import { createHopGate, hopGateFromEnv } from './hop-gate.ts';

/**
 * Ворота записи звена (P131) без сети: файл итога — подставное чтение, паузы опроса считаются. Ворота ждут только «ещё не записан»; отказ ядра и истёкший срок команду отпускают,
 * а канал, однажды не дождавшийся, дальше не держит.
 */

const PID = 4242;

const accepted = (pids: number[]): HopRecordFile => ({
  v: 1,
  pids,
  channels: { core: { ok: true, accepted: pids, refused: [], recordedAt: 1 } },
});

function stand(records: (HopRecordFile | null)[], timeoutMs = 100) {
  let reads = 0;
  let slept = 0;
  const gate = createHopGate({
    file: 'hops.json',
    pid: PID,
    timeoutMs,
    pollMs: 10,
    read: () => records[Math.min(reads++, records.length - 1)] ?? null,
    // Паузы считаются: по их числу видно, ждали ворота или отпустили сразу.
    sleep: (ms) => {
      slept += 1;
      return new Promise((done) => setTimeout(done, ms));
    },
  });
  return { gate, reads: () => reads, slept: () => slept };
}

describe('hop gate (P131)', () => {
  it('waits while the record is missing, opens when this pid is recorded, and does not re-read after', async () => {
    const s = stand([null, null, accepted([PID])]);
    expect(await s.gate('core')).toBe('recorded');
    expect(s.slept()).toBe(2);
    const readsAfter = s.reads();
    expect(await s.gate('core')).toBe('recorded');
    expect(s.reads()).toBe(readsAfter);
  });

  it('a refusal of this pid releases the command at once, without waiting the timeout', async () => {
    const refused: HopRecordFile = {
      v: 1,
      pids: [PID],
      channels: { core: { ok: false, code: 'unproven-reply' } },
    };
    const s = stand([refused], 10_000);
    expect(await s.gate('core')).toBe('refused');
    expect(s.slept()).toBe(0);
  });

  it('a channel that timed out once is not held again: the next command goes at once', async () => {
    const s = stand([accepted([PID + 1])], 50);
    expect(await s.gate('core')).toBe('timeout');
    expect(s.slept()).toBeGreaterThan(0);
    const sleptBefore = s.slept();
    expect(await s.gate('core')).toBe('timeout');
    expect(s.slept()).toBe(sleptBefore);
  });

  it('no record file in the environment → no gate; a file named → a gate', () => {
    expect(hopGateFromEnv({}, PID)).toBeUndefined();
    expect(hopGateFromEnv({ AGENTDECK_HOP_RECORD: '  ' }, PID)).toBeUndefined();
    expect(typeof hopGateFromEnv({ AGENTDECK_HOP_RECORD: '/tmp/hops.json' }, PID)).toBe('function');
  });
});
