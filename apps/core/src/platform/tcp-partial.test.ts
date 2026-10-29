import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DARWIN_PS_ARGS, parseDarwinPs } from './process-table.ts';
import { readLinuxTcp } from './tcp-table.ts';

const root = mkdtempSync(join(tmpdir(), 'tcp-partial-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const ROW =
  '   0: 0100007F:1438 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1\n';

function fakeProc(tcp6: 'absent' | 'unreadable' | 'ok'): string {
  const proc = mkdtempSync(join(root, 'proc-'));
  mkdirSync(join(proc, 'net'));
  writeFileSync(join(proc, 'net', 'tcp'), HEADER + ROW);
  // Каталог на месте файла: чтение падает не ENOENT (EISDIR) — сбой, а не «IPv6 нет».
  if (tcp6 === 'unreadable') mkdirSync(join(proc, 'net', 'tcp6'));
  if (tcp6 === 'ok') writeFileSync(join(proc, 'net', 'tcp6'), HEADER);
  return proc;
}

describe('F-114 TCP table — a partial table is unknown, not complete', () => {
  it('F-114 Linux: tcp6 present but unreadable → unknown; tcp6 absent (no IPv6) → the IPv4 table', () => {
    expect(readLinuxTcp(fakeProc('unreadable'))).toMatchObject({
      unknown: expect.stringContaining('tcp6'),
    });
    expect(readLinuxTcp(fakeProc('absent'))).toMatchObject({
      value: [expect.objectContaining({ state: 'listen', localPort: 5176 })],
    });
    expect(readLinuxTcp(fakeProc('ok'))).toMatchObject({ value: [expect.anything()] });
  });

  it('F-114 Linux: the IPv4 table unreadable while tcp6 reads → unknown, never the IPv6 half alone', () => {
    const proc = mkdtempSync(join(root, 'proc-'));
    mkdirSync(join(proc, 'net'));
    writeFileSync(join(proc, 'net', 'tcp6'), HEADER);
    expect(readLinuxTcp(proc)).toMatchObject({ unknown: expect.stringContaining('tcp') });
  });

  it('F-114 console code page: a failed reg.exe query is not cached — the next call asks again', async () => {
    const answers: (number | undefined)[] = [undefined, 866];
    let asked = 0;
    const query = async () => {
      asked += 1;
      return answers.shift();
    };
    // Свой экземпляр модуля: кэш процесса другими тестами не заполнен.
    vi.resetModules();
    const { consoleCodePage } = await import('./run-tool.ts');
    expect(await consoleCodePage('win32', query)).toBeUndefined();
    expect(await consoleCodePage('win32', query)).toBe(866);
    expect(await consoleCodePage('win32', query)).toBe(866);
    expect(asked).toBe(2);
  });
});

describe('F-59 macOS process identity — survives a process title change', () => {
  it('F-59 ps reads the accounting name (ucomm), not argv: the start token does not move when argv is rewritten', () => {
    expect(DARWIN_PS_ARGS).toContain('ucomm=');
    expect(DARWIN_PS_ARGS).not.toContain('command=');
    const before = parseDarwinPs('  321     1 Ss   Wed Oct 28 10:15:32 2026 node\n');
    const after = parseDarwinPs('  321     1 Ss   Wed Oct 28 10:15:32 2026 node\n');
    expect(before[0]?.start).toBe(after[0]?.start);
    const other = parseDarwinPs('  321     1 Ss   Wed Oct 28 10:15:32 2026 python3\n');
    expect(other[0]?.start).not.toBe(before[0]?.start);
  });
});
