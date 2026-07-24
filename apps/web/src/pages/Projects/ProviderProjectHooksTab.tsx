import { ProviderHooksPanel } from '@pages/ProviderHooks/ProviderHooksPanel';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/**
 * Хуки проекта в модели «ключ конфига» (OPENCODE-3): тот же экран, что и на
 * глобальном уровне, но файл берётся из проекта (`<проект>/opencode.json`).
 */
export function ProviderProjectHooksTab({ projectId }: ProjectTabProps) {
  return <ProviderHooksPanel projectId={projectId} />;
}
