export interface FolderPickerProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Выбранная папка — абсолютный путь. Открывается как проект. */
  onPick: (path: string, name: string) => void;
}
