import { ProviderRulesPanel } from '@pages/ProviderRules/ProviderRulesPanel';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/**
 * Правила проекта в модели КАТАЛОГА `.mdc` (CURSOR-1): тот же экран, что и на
 * глобальном уровне, но каталог берётся из проекта (`<проект>/.cursor/rules`), а
 * защита путей не выпускает правки за его пределы.
 */
export function ProviderProjectRulesTab({ projectId }: ProjectTabProps) {
  return <ProviderRulesPanel projectId={projectId} />;
}
