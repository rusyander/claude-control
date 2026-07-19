import type { Artifact } from '@agentdeck/contracts';

export interface ArtifactPreviewProps {
  chatId: string;
  artifact: Artifact;
  onClose: () => void;
}
