export interface ProjectBindingProps {
  /** Пути проектов, к которым привязана группа. */
  value: string[];
  onChange: (next: string[]) => void;
}
