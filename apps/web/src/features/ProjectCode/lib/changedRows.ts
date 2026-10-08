import type { ProjectFileChange, ProjectGitChange } from '@agentdeck/contracts';
import type { ChangedRow } from './changedRows.types';

export function changedRows(
  agent: ProjectFileChange[] | undefined,
  git: ProjectGitChange[] | undefined,
): ChangedRow[] {
  const byPath = new Map<string, ProjectGitChange>();
  for (const change of git ?? []) byPath.set(change.path, change);

  const rows: ChangedRow[] = [];
  const seen = new Set<string>();

  for (const change of agent ?? []) {
    const status = byPath.get(change.path);
    seen.add(change.path);
    rows.push({
      path: change.path,
      source: 'agent',
      added: change.added,
      removed: change.removed,
      ...(change.missing ? { missing: true } : {}),
      ...(status ? { status: status.status, staged: status.staged } : {}),
    });
  }

  for (const change of git ?? []) {
    if (seen.has(change.path)) continue;
    rows.push({
      path: change.path,
      source: 'git',
      status: change.status,
      staged: change.staged,
    });
  }

  return rows;
}
