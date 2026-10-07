import { spawn } from 'node:child_process';

/**
 * Запуск сервера моделей на Windows через скрытую консоль.
 *
 * Прямой `spawn(..., { detached: true })` даёт процессу DETACHED_PROCESS — у
 * Ollama нет консоли вовсе, и каждый её служебный процесс (поиск видеокарт —
 * полтора десятка за запуск, исполнитель модели) заводит СВОЮ консоль. При
 * Windows Terminal по умолчанию это вкладка на каждый: живой замер 08.10 —
 * 15 вкладок за запуск, поиск видеокарт 50 с вместо 3, потому что каждый
 * процесс ждал открытия своей вкладки.
 *
 * Поэтому промежуточный PowerShell: панель поднимает его со скрытой консолью
 * (windowsHide), он — Ollama через Start-Process -WindowStyle Hidden, и Ollama с
 * её детьми живут в той же невидимой консоли. Внук панели не попадает в её
 * задание (libuv ставит SILENT_BREAKAWAY_OK), так что сервер переживает
 * перезапуск панели так же, как прежде с detached.
 */

/** Строка в одинарных кавычках PowerShell: внутри удваивается только `'`. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Скрипт PowerShell: запустить, перенаправить вывод, напечатать номер процесса. */
export function hiddenLaunchScript(
  binary: string,
  args: string[],
  log: { out: string; err: string },
): string {
  const list = args.length ? ` -ArgumentList ${args.map(psQuote).join(',')}` : '';
  return (
    `$p = Start-Process -FilePath ${psQuote(binary)}${list} -WindowStyle Hidden -PassThru ` +
    `-RedirectStandardOutput ${psQuote(log.out)} -RedirectStandardError ${psQuote(log.err)}; ` +
    `[Console]::Out.Write($p.Id)`
  );
}

/** Запустить и вернуть номер процесса самого сервера (не PowerShell). */
export function launchHidden(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  log: { out: string; err: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', hiddenLaunchScript(binary, args, log)],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += String(chunk)));
    child.stderr.on('data', (chunk: Buffer) => (err += String(chunk)));
    child.once('error', reject);
    child.once('exit', (code) => {
      const pid = Number(out.trim());
      if (code === 0 && Number.isInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error(err.trim() || `powershell exited ${code ?? -1}`));
    });
  });
}

/** Жив ли процесс: сигнал 0 ничего не шлёт, только проверяет. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
