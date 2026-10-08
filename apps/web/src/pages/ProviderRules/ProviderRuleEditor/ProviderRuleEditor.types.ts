import type { ProviderRulesFormat } from '@agentdeck/contracts';

export interface ProviderRuleEditorProps {
  /** Формат каталога: решает, есть ли у правила `alwaysApply`, и подписи полей. */
  format: ProviderRulesFormat;
  /** Путь правила относительно каталога правил. */
  path: string;
  projectId?: string;
  onClose: () => void;
}
