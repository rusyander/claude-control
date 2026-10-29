import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Свой процесс с закрытым окружением на Linux — как ssh-agent: `sleep` без права чтения, ядро
 * снимает dumpable при запуске, и `/proc/<pid>/environ` отдаёт EACCES. Виден любому поиску по
 * метке в той же системе — только для файлов `*.alone.test.ts`.
 */
export function closedSleepers(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const live: ChildProcess[] = [];
  let made = 0;
  return {
    async start(env: NodeJS.ProcessEnv = {}): Promise<number> {
      const bin = join(dir, `sleep-x-${(made += 1)}`);
      copyFileSync('/bin/sleep', bin);
      chmodSync(bin, 0o111);
      const child = spawn(bin, ['60'], { stdio: 'ignore', env: { ...process.env, ...env } });
      live.push(child);
      const pid = child.pid ?? 0;
      for (let i = 0; i < 50; i += 1) {
        try {
          readFileSync(`/proc/${pid}/environ`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EACCES') return pid;
        }
        await settle(20);
      }
      throw new Error(`setup: environ of pid ${pid} stayed readable — not a closed process`);
    },
    killAll(): void {
      for (const child of live.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
    },
    dispose(): void {
      this.killAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
