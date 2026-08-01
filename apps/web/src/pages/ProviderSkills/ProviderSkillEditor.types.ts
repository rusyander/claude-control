export interface ProviderSkillEditorProps {
  /** Путь `SKILL.md` относительно каталога скиллов. */
  path: string;
  projectId?: string;
  onClose: () => void;
}
