import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendIoRecord, IO_RECORD, readIoRecord } from './io-record.ts';

/**
 * Ядро умерло посреди append (ревью core-s2 F-23): хвост файла без `\n`. Следующее ядро не
 * должно приклеивать свою строку к обрывку — иначе обе пропадут при чтении, а отправка без
 * подтверждения не будет повторена тем же cmdId.
 */
describe('io-record', () => {
  it('torn tail: the next append starts on its own line, nothing after the tear is lost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iorec-'));
    writeFileSync(
      join(dir, IO_RECORD),
      '{"t":"send","cmdId":"a","uuid":"u1","at":0,"data":"x"}\n{"t":"ack","cm',
    );
    appendIoRecord(dir, { t: 'send', cmdId: 'b', uuid: 'u2', at: 10, data: 'y' });
    appendIoRecord(dir, { t: 'control', id: 'c1' });
    const record = readIoRecord(dir);
    expect(record.sends.map((s) => s.cmdId)).toEqual(['a', 'b']);
    expect(record.sends.every((s) => !s.acked)).toBe(true);
    expect([...record.controls]).toEqual(['c1']);
  });

  it('a line already glued to a tear (written before the fix) is recovered on read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iorec-'));
    writeFileSync(
      join(dir, IO_RECORD),
      '{"t":"send","cmdId":"a","uuid":"u1","at":0,"data":"{\\"t\\":1"}\n' +
        '{"t":"ack","cm{"t":"send","cmdId":"b","uuid":"u2","at":10,"data":"y"}\n',
    );
    expect(readIoRecord(dir).sends.map((s) => [s.cmdId, s.data])).toEqual([
      ['a', '{"t":1'],
      ['b', 'y'],
    ]);
  });

  it('whole tail: no blank line is inserted between intact lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iorec-'));
    appendIoRecord(dir, { t: 'send', cmdId: 'a', uuid: 'u1', at: 0, data: 'x' });
    appendIoRecord(dir, { t: 'ack', cmdId: 'a' });
    const text = readFileSync(join(dir, IO_RECORD), 'utf8');
    expect(text.split('\n')).toHaveLength(3);
    expect(readIoRecord(dir).sends).toEqual([
      { t: 'send', cmdId: 'a', uuid: 'u1', at: 0, data: 'x', acked: true },
    ]);
  });
});
