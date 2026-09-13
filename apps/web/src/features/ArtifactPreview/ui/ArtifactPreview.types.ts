import type { Artifact, MediaImage } from '@agentdeck/contracts';

/** Что показывает панель: сам файл или его исходник. */
export type Tab = 'preview' | 'source';

export interface ArtifactPreviewProps {
  chatId: string;
  artifact: Artifact;
  onClose: () => void;
}

export interface PreviewBodyProps {
  chatId: string;
  artifact: ArtifactPreviewProps['artifact'];
  documentHtml: string;
}

export interface MediaImageCardProps {
  image: MediaImage;
  onClose: () => void;
}

export interface ArtifactPlainTextProps {
  chatId: string;
  name: string;
}
