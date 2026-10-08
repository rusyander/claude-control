import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { observeCliExits, watchCliChild, type CliExit } from './cli-spawn.ts';

/**
 * Ревью 28.09 (F-207): хвост stderr склеивался `String(chunk)` по кускам —
 * русская буква, разрезанная между кусками, становилась U+FFFD в улике.
 * Настоящий процесс пишет байты буквы двумя записями с паузой между ними.
 */

afterEach(() => observeCliExits(undefined));

describe('хвост stderr упавшего CLI', () => {
  it('буква, разрезанная между кусками, приходит целой', async () => {
    const seen = new Promise<CliExit>((resolve) => observeCliExits(resolve));
    const script = [
      "const bytes = Buffer.from('ошибка', 'utf8');",
      'process.stderr.write(bytes.subarray(0, 3));',
      'setTimeout(() => { process.stderr.write(bytes.subarray(3)); process.exitCode = 1; }, 150);',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', script], {
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    watchCliChild('node', ['-e'], child);
    child.stdout.resume();
    child.stderr.resume();
    const exit = await seen;
    expect(exit.code).toBe(1);
    expect(exit.stderr).toBe('ошибка');
  });
});
