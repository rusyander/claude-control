import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';

/**
 * Запуск «вместо себя» для обёрток PATH (обёртка движка контейнеров, P58): настоящая программа
 * получает поток ввода-вывода обёртки как есть, обёртка отдаёт её код выхода. Сигнал —
 * 128 + номер (как оболочка); программа не запустилась — 127 и причина в stderr.
 */
export function runPassthrough(file: string, args: readonly string[], label: string): number {
  const run = spawnSync(file, [...args], { stdio: 'inherit', windowsHide: true });
  if (run.error) {
    process.stderr.write(`${label}: ${run.error.message}\n`);
    return 127;
  }
  if (run.signal) return 128 + (constants.signals[run.signal] ?? 1);
  return run.status ?? 1;
}
