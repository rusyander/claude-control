import { ProviderSkillsPanel } from '@pages/ProviderSkills/ProviderSkillsPanel';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/**
 * Скиллы проекта (OPENCODE-5): тот же экран, что и на глобальном уровне, но
 * каталог берётся из проекта (`<проект>/.opencode/skills`), а защита путей не
 * выпускает правки за его пределы.
 */
export function ProviderProjectSkillsTab({ projectId }: ProjectTabProps) {
  return <ProviderSkillsPanel projectId={projectId} />;
}
