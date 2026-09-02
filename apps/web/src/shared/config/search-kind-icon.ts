import type { SearchResultKind } from '@claude-control/contracts';
import type { IconName } from '@shared/ui/icon';

/**
 * Иконка раздела, из которого пришёл результат поиска. Один список на страницу
 * поиска и командную палитру — иначе один и тот же вид результата выглядел бы в
 * них по-разному.
 */
export const KIND_ICON: Record<SearchResultKind, IconName> = {
  rule: 'rules',
  skill: 'skills',
  hook: 'hooks',
  script: 'scripts',
  plugin: 'plugins',
  mcp: 'mcp',
  permission: 'permissions',
  env: 'env',
  // Файл глобальных инструкций провайдера (AGENTS.md/GEMINI.md) — та же иконка,
  // что и у раздела инструкций в навигации.
  instructions: 'file',
  group: 'groups',
};
