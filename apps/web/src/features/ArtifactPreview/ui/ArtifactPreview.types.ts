import type { Artifact } from '@claude-control/contracts';

export interface ArtifactPreviewProps {
  chatId: string;
  artifact: Artifact;
  onClose: () => void;
}
