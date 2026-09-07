import type { ProjectGitFileStatus } from '@agentdeck/contracts';

/**
 * Буква git у состояния файла — короче и понятнее любого перевода.
 *
 * Живёт в `shared`, а не у пульта git: те же буквы стоят в списке изменённых
 * файлов окна кода, а фичи друг к другу не ходят. Своя копия там разошлась бы с
 * этой при первой же правке.
 */
export const STATUS_LETTER: Record<ProjectGitFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  typechange: 'T',
  untracked: '?',
  conflict: 'U',
};
