import { ProviderInstructionsPanel } from '@pages/ProviderInstructions/ProviderInstructionsPanel';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/**
 * Инструкции проекта в модели СПИСКА ССЫЛОК (AIDER-4): тот же экран, что и на
 * глобальном уровне, но конфигурация берётся из корня проекта
 * (`<проект>/.aider.conf.yml`), а перечисленные файлы открываются только внутри
 * каталога проекта.
 */
export function ProviderProjectInstructionsListTab({ projectId }: ProjectTabProps) {
  return <ProviderInstructionsPanel projectId={projectId} />;
}
