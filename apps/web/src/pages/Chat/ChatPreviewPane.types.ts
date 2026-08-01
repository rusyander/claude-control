import type { Artifact } from '@claude-control/contracts';

export interface ChatPreviewPaneProps {
  chatId: string;
  artifact: Artifact;
  /** Текущая ширина панели в пикселях — её же тянет ручка слева. */
  width: number;
  onResize: (width: number) => void;
  onClose: () => void;
}
