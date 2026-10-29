import { pidAlive } from '../../platform/kept-launch.ts';
import { isInside } from '../../platform/paths.ts';
import { runTool } from '../../platform/run-tool.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { ensureDir, listDir, readBytesSync } from '../../platform/safe-io/files.ts';
import { removeVerified } from '../../platform/safe-io/remove.ts';
import type { MutateIo } from './mutate.types.ts';

/**
 * Настоящий ввод-вывод мутанта — только платформа: чтение — факт (EPERM сканера повторяется, не
 * читается как «нет»), запись — атомарная замена с режимом цели (исполняемый бит остаётся), удаление
 * — с проверкой чтением.
 */
export function platformMutateIo(): MutateIo {
  return {
    readBytes: (path) => readBytesSync(path),
    writeBytes: (path, bytes) => writeFileAtomic(path, bytes),
    listDir,
    ensureDir,
    remove: (path) => removeVerified(path),
    pidAlive,
    inside: (parent, child) => isInside(parent, child),
    gitRevParse: async (cwd, args) => {
      const run = await runTool('git', ['rev-parse', ...args], { cwd, timeoutMs: 15_000 });
      if (!run.ok) return undefined;
      const out = run.stdout.trim();
      return out === '' ? undefined : out;
    },
  };
}
