import { ProviderPluginsPanel } from '@pages/ProviderPlugins/ProviderPluginsPanel';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/**
 * Плагины проекта (OPENCODE-4): тот же экран, что и на глобальном уровне, но
 * каталог и конфиг берутся из проекта (`<проект>/.opencode/plugins`,
 * `<проект>/opencode.json`), а защита путей не выпускает правки за его пределы.
 */
export function ProviderProjectPluginsTab({ projectId }: ProjectTabProps) {
  return <ProviderPluginsPanel projectId={projectId} />;
}
