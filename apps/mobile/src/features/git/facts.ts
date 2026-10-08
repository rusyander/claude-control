import type { ProjectGitInfo } from '@agentdeck/contracts';
import type { Dictionary } from '../../shared/config/i18n';

/** Состояние репозитория словами: что впереди, что изменено, куда отправлять. */
export function facts(info: ProjectGitInfo, t: Dictionary): string[] {
  const parts: string[] = [];
  if (info.ahead === undefined) parts.push(t.git.noUpstream);
  else if (info.ahead > 0) parts.push(`↑${info.ahead}`);
  if (info.behind) parts.push(`↓${info.behind}`);
  parts.push(info.dirtyCount > 0 ? t.git.dirty(info.dirtyCount) : t.git.clean);
  parts.push(info.remote ? info.remote : t.git.noRemote);
  return parts;
}
