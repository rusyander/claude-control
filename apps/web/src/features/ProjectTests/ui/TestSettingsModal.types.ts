import type { TestsBoard } from '../model/useTestsBoard';

export interface TestSettingsModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  board: TestsBoard;
}

/**
 * Разделы окна получают один и тот же доступ к набору: они правят РАЗНЫЕ файлы
 * одного проекта, и раскладывать по ним куски вида пришлось бы всё равно.
 */
export interface TestSettingsSectionProps {
  board: TestsBoard;
  /** Сообщить об отказе сервера общей строкой окна — она одна на все разделы. */
  onError: (message?: string) => void;
}
