import type { ProjectGitChange } from '@agentdeck/contracts';

export const MARKS: Record<ProjectGitChange['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  typechange: 'T',
  untracked: '?',
  conflict: '!',
};
