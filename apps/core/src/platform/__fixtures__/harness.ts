import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Общие помощники тестов платформы: дерево процессов из `tree.mjs` и ожидание условия. */

export const TREE_SCRIPT = fileURLToPath(new URL('./tree.mjs', import.meta.url));

export async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

export interface TreeRun {
  dir: string;
  root: ChildProcess;
  pidOf(role: string): number | undefined;
  waitPids(roles: readonly string[]): Promise<Record<string, number>>;
  exit(role: string): void;
  /** Снять всё, что осталось (по номерам из файлов), и удалить каталог. */
  cleanup(): void;
}

export function startTree(plan: string, env: Record<string, string> = {}): TreeRun {
  const dir = mkdtempSync(join(tmpdir(), 'tree-'));
  const root = spawn(process.execPath, [TREE_SCRIPT, dir, 'root'], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, TREE_PLAN: plan, ...env },
  });
  const pidOf = (role: string): number | undefined => {
    const file = join(dir, `${role}.pid`);
    return existsSync(file) ? Number(readFileSync(file, 'utf8')) || undefined : undefined;
  };
  return {
    dir,
    root,
    pidOf,
    async waitPids(roles) {
      const out: Record<string, number> = {};
      for (const role of roles) out[role] = await waitFor(() => pidOf(role), 15_000, `${role}.pid`);
      return out;
    },
    exit(role) {
      writeFileSync(join(dir, `${role}.exit`), '');
    },
    cleanup() {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.pid')) continue;
        writeFileSync(join(dir, name.replace('.pid', '.exit')), '');
      }
      try {
        root.kill('SIGKILL');
      } catch {
        // уже вышел
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** Жив ли номер (без личности) — только для проверок тестов, не для решений ядра. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
