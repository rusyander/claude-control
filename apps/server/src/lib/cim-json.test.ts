import { describe, expect, it } from 'vitest';
import { parseCimJson } from './cim-json.ts';

/**
 * Вывод `ConvertTo-Json -Compress` PowerShell 5.1: управляющий символ в строке одного объекта
 * не роняет разбор остальных (проход s10, F3: BEL в командной строке хоста qwen → 503).
 */
describe('parseCimJson', () => {
  it('a raw control char inside one string keeps every row, the char becomes a space', () => {
    const bel = String.fromCharCode(7);
    const stdout = `[{"ProcessId":1,"CommandLine":"qwen a${bel}b"},{"ProcessId":2,"CommandLine":"claude"}]\r\n`;
    expect(parseCimJson<{ ProcessId: number; CommandLine: string }>(stdout)).toEqual([
      { ProcessId: 1, CommandLine: 'qwen a b' },
      { ProcessId: 2, CommandLine: 'claude' },
    ]);
  });

  it('escaped control chars leave no control char in the parsed strings; BOM, one object, empty', () => {
    const bom = String.fromCharCode(0xfeff);
    expect(parseCimJson<{ c: string; n: number }>(`${bom}{"c":"x\\ty\\u0007z\\"q","n":3}`)).toEqual(
      [{ c: 'x y z"q', n: 3 }],
    );
    expect(parseCimJson('  \r\n')).toEqual([]);
  });

  it('output that is not JSON at all still throws: the caller reads it as «no list»', () => {
    expect(() => parseCimJson('Get-CimInstance : access denied')).toThrow();
  });
});
