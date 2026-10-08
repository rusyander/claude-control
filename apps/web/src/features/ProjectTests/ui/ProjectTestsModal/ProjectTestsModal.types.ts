export interface ProjectTestsModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Каталог проекта: кейсы лежат в нём, а не в панели. */
  projectPath: string;
}
