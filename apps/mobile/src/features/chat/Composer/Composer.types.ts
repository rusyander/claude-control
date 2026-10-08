import type { Upload } from '../../../shared/lib/runs';

export interface ComposerValue {
  text: string;
  allowEdits: boolean;
  /**
   * Авторежим прав, выбранный в этом чате. Не тронут — не шлётся вовсе, и сервер
   * берёт выбор чата или глобальную настройку панели (включена из коробки).
   */
  autoApprove?: boolean;
  model: string;
  effort: string;
  files: Upload[];
}
