import { newId } from '../../lib/ids/uuidv7.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { ProcessIdentity } from '../../platform/process-table.ts';
import { createStandWatch, type StandRegistry } from '../../verifier/stand/index.ts';
import type { StandRef } from './refs.ts';

/**
 * Стенд задачи (04:75-77): процесс стенда — ресурс `stand` (снятие — процесс + адрес здоровья
 * молчит, P40/P90), адрес здоровья — под наблюдением реестра (эпоха → `no-verdict(stand)` у C).
 * Личность процесса читает вызывающий (pid + старт): смена — перезапуск стенда, эпоха растёт.
 */
export function attachStand(
  task: LiveTask,
  registry: StandRegistry,
  stand: { key?: string; process: ProcessIdentity; health: string; intervalMs?: number },
  identity?: () => Promise<{ value: string } | { unknown: string } | { absent: true }>,
): string {
  const rid = newId();
  const ref: StandRef = {
    pid: stand.process.pid,
    start: stand.process.start,
    health: stand.health,
    // Ключ наблюдения — в записи: снятие концом задачи снимает и наблюдение этого стенда.
    ...(stand.key !== undefined ? { key: stand.key } : {}),
  };
  task.append({
    kind: 'resource.created',
    actor: 'core',
    data: { rid, kind: 'stand', owner: 'core', release: 'task-end', ref: JSON.stringify(ref) },
  });
  registry.attach(
    stand.key ?? task.taskId,
    createStandWatch({
      health: stand.health,
      ...(stand.intervalMs !== undefined ? { intervalMs: stand.intervalMs } : {}),
      ...(identity ? { identity } : {}),
    }),
  );
  return rid;
}
