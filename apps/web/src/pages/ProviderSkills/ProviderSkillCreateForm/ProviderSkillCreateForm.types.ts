export interface ProviderSkillCreateFormProps {
  skillsDir: string;
  /** Уже занятые имена папок — чтобы не создать дубликат. */
  existing: string[];
  projectId?: string;
  onCreated: (path: string) => void;
}
