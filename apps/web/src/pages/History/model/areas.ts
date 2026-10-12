import { CHANGELOG_AREAS, type ChangelogArea } from '@agentdeck/contracts/changelog';

export const AREA_ORDER: readonly ChangelogArea[] = CHANGELOG_AREAS;

/**
 * Цвет сегмента полосы «Что затронуто». Цвет не единственный носитель смысла:
 * у каждого сегмента есть название в подписи и в легенде под полосой.
 */
export const AREA_COLOR: Record<ChangelogArea, string> = {
  web: 'var(--color-accent)',
  server: 'var(--color-info)',
  mobile: 'var(--color-success)',
  contracts: 'var(--color-warning)',
  tools: 'color-mix(in srgb, var(--color-accent) 55%, var(--color-success))',
  tests: 'var(--color-fg-muted)',
  docs: 'var(--color-border-strong)',
  other: 'var(--color-fg-subtle)',
};
