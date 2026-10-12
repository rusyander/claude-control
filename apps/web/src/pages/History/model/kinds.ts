import { CHANGELOG_KINDS, type ChangelogKind } from '@agentdeck/contracts/changelog';

/**
 * Порядок видов изменений в теле выпуска и в шапке: сначала то, что человек
 * заметит (добавлено, улучшено, исправлено), потом то, что только сопровождает.
 * Один порядок на всё — группы в теле, счётчики в шапке и чипы фильтра.
 */
export const KIND_ORDER: readonly ChangelogKind[] = CHANGELOG_KINDS;

/** Токен цвета вида: точка в шапке, маркер группы, чип фильтра. */
export const KIND_COLOR: Record<ChangelogKind, string> = {
  added: 'var(--color-success)',
  improved: 'var(--color-info)',
  fixed: 'var(--color-accent)',
  changed: 'var(--color-warning)',
  removed: 'var(--color-danger)',
  docs: 'var(--color-fg-muted)',
  internal: 'var(--color-border-strong)',
};
