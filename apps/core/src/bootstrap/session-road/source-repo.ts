import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';

/**
 * Исходный репозиторий шага (F-86): путь из `task.created.repos[]` — ИСХОДНИК, не одноразовая
 * копия (по нему CLI хранит доверие к папке, по нему конфиг ядра даёт список чтения человека).
 * Один репозиторий — он; несколько — тот, чей ключ у единицы шага (`unit.created.repoKey`).
 * Не нашёлся — `undefined`: копия идёт недоверенной, а не с чужим доверием.
 */
export function sourceRepoOf(task: LiveTask, stepId: string): string | undefined {
  const repos = task.state.created?.repos ?? [];
  if (repos.length === 1) return repos[0]!.path;
  if (repos.length === 0) return undefined;
  const unitId = task.state.steps[stepId]?.unitId;
  if (!unitId) return undefined;
  const lines = readJournalLines(task.dir, task.taskId).lines as JournalLine[];
  const unit = lines.find((l) => l.kind === 'unit.created' && l.unitId === unitId);
  const repoKey = (unit?.data as { repoKey?: string } | undefined)?.repoKey;
  return repos.find((r) => r.repoKey === repoKey)?.path;
}
