import type { Artifact } from '@claude-control/contracts';

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

export interface ArtifactPlainTextProps {
  chatId: string;
  name: string;
}

export interface TabButtonProps {
  isActive: boolean;
  onClick: () => void;
  children: string;
}
