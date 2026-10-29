import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readBytesSync } from './files.ts';
import type { RetryPolicy } from './retry.ts';

/**
 * P55 (09 §atomic replace): на Windows чтение файла, который в этот миг держит или заменяет
 * другой процесс (антивирус, индексатор, `rename` писателя), отвечает EPERM/EBUSY. Читатель
 * ядра повторяет такие коды ограниченно и лишь потом говорит «неизвестно» — никогда «нет».
 *
 * Настоящий путь: дочерний процесс открывает файл с исключительной блокировкой libuv
 * (`UV_FS_O_EXLOCK`, доступ без общего чтения) — ОС отвечает читателю EBUSY, пока держатель
 * не отпустит файл. Это тот же класс отказа, что гонка замены снимка, но без случайности.
 */

const UV_FS_O_EXLOCK = 0x10000000;
const NO_SLEEP: RetryPolicy = { attempts: 6, delayMs: () => 0, sleep: () => undefined };

/** Держатель файла в отдельном процессе: открыл с блокировкой, сказал `held`, отпустил через `ms`. */
function holdExclusive(path: string, ms: number): Promise<{ released: Promise<void> }> {
  const script = [
    "const fs = require('node:fs');",
    `const fd = fs.openSync(${JSON.stringify(path)}, fs.constants.O_RDONLY | ${UV_FS_O_EXLOCK});`,
    "process.stdout.write('held\\n');",
    `setTimeout(() => { fs.closeSync(fd); process.exit(0); }, ${ms});`,
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const released = new Promise<void>((resolve) => child.on('close', () => resolve()));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString('utf8').includes('held')) resolve({ released });
    });
  });
}

describe('safe-io reads under a transient lock', () => {
  it.runIf(process.platform === 'win32')(
    'P55 a file held exclusively by another process for a moment is read once it is released, not reported unknown',
    async () => {
      const file = join(tempDir('read-'), 'snapshot.json');
      writeFileSync(file, '{"seq":7}');
      const { released } = await holdExclusive(file, 120);
      // Синхронное чтение блокирует этот процесс; держатель отпускает файл сам, по своему таймеру.
      const read = readBytesSync(file);
      await released;
      expect(read).toEqual({ value: Buffer.from('{"seq":7}') });
    },
  );

  it.runIf(process.platform === 'win32')(
    'P44 a lock held past the retry bound stays unknown with the OS code, never absent',
    async () => {
      const file = join(tempDir('read-'), 'snapshot.json');
      writeFileSync(file, 'x');
      const { released } = await holdExclusive(file, 4_000);
      const read = readBytesSync(file);
      await released;
      expect('unknown' in read && read.unknown).toMatch(/^EBUSY: /);
    },
  );

  it('P44 EPERM/EBUSY are retried up to the bound; other codes and a missing path are not', () => {
    const file = join(tempDir('read-'), 'f.json');
    writeFileSync(file, 'ok');
    const failing = (code: string, times: number) => {
      let calls = 0;
      const read = (path: string): Buffer => {
        calls += 1;
        if (calls <= times) throw Object.assign(new Error(`${code}: read`), { code });
        return Buffer.from(`read ${path.endsWith('f.json')}`);
      };
      return { read, calls: () => calls };
    };
    const recovers = failing('EPERM', 2);
    expect(readBytesSync(file, { retry: NO_SLEEP, read: recovers.read })).toEqual({
      value: Buffer.from('read true'),
    });
    expect(recovers.calls()).toBe(3);
    const stuck = failing('EBUSY', 99);
    expect(readBytesSync(file, { retry: NO_SLEEP, read: stuck.read })).toEqual({
      unknown: 'EBUSY: EBUSY: read',
    });
    expect(stuck.calls()).toBe(NO_SLEEP.attempts);
    // EACCES на POSIX — настоящий запрет доступа, ожиданием он не лечится: сразу «неизвестно».
    const denied = failing('EACCES', 99);
    expect(readBytesSync(file, { retry: NO_SLEEP, read: denied.read })).toEqual({
      unknown: 'EACCES: EACCES: read',
    });
    expect(denied.calls()).toBe(1);
    const never = failing('EPERM', 99);
    expect(
      readBytesSync(join(file, '..', 'нет.json'), { retry: NO_SLEEP, read: never.read }),
    ).toEqual({
      absent: true,
    });
    expect(never.calls()).toBe(0);
  });
});
