import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** На Windows claude — это .cmd-обёртка, её нельзя запустить без shell. */
const isWindows = process.platform === 'win32';

export async function runClaude(
  command: string,
  args: string[],
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    windowsHide: true,
    shell: isWindows,
    maxBuffer: 10 * 1024 * 1024,
  });
}
