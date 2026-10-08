import type { ProviderRulesFormat } from '@agentdeck/contracts';

export interface ProviderRuleCreateFormProps {
  rulesDir: string;
  /** Формат каталога: решает расширение, поля и подписи формы. */
  format: ProviderRulesFormat;
  /** Уже занятые пути — чтобы не создать дубликат. */
  existing: string[];
  projectId?: string;
  onCreated: (path: string) => void;
}
