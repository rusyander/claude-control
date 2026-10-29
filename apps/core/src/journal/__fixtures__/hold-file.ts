import { spawn } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Чужой читатель держит файл — как антивирус или резервная копия (ревью M3, M4). Настоящий
 * путь ОС, без подмены: на Windows — отдельный процесс PowerShell открывает файл с нужным
 * разделением; на POSIX обязательных блокировок нет, ближайший настоящий отказ — права.
 *   - `unreadable`: файл нельзя прочитать (Windows: FileShare.None; POSIX: chmod 000);
 *   - `undeletable`: файл нельзя заменить переименованием (Windows: без FILE_SHARE_DELETE;
 *     POSIX: каталог только на чтение).
 * Ответ — отпустить; ждёт, пока держатель действительно ушёл.
 */
export type HoldMode = 'unreadable' | 'undeletable';

export async function holdFile(path: string, mode: HoldMode): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') {
    const target = mode === 'unreadable' ? path : dirname(path);
    chmodSync(target, mode === 'unreadable' ? 0o000 : 0o555);
    return async () => chmodSync(target, mode === 'unreadable' ? 0o644 : 0o755);
  }
  const share = mode === 'unreadable' ? 'None' : 'ReadWrite';
  const script =
    `$f=[System.IO.File]::Open($env:HOLD_PATH,'Open','Read','${share}');` +
    `[Console]::Out.WriteLine('held');[Console]::Out.Flush();` +
    `[Console]::In.ReadLine()|Out-Null;$f.Close()`;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, HOLD_PATH: path },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve();
    });
    child.on('exit', (code) => reject(new Error(`holder exited early: ${code}`)));
  });
  return async () => {
    child.stdin.end('\n');
    await exited;
  };
}
