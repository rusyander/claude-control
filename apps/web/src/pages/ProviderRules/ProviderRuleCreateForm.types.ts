export interface ProviderRuleCreateFormProps {
  rulesDir: string;
  /** Уже занятые пути — чтобы не создать дубликат. */
  existing: string[];
  projectId?: string;
  onCreated: (path: string) => void;
}
