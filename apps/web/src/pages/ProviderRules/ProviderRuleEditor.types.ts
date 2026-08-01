export interface ProviderRuleEditorProps {
  /** Путь правила относительно каталога правил. */
  path: string;
  projectId?: string;
  onClose: () => void;
}
