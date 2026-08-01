import type { Artifact } from '@claude-control/contracts';

export interface ChatArtifactsBarProps {
  /** Файлы, созданные агентом в папке разговора; пусто — полосы нет вовсе. */
  artifacts: Artifact[];
  onPreview: (artifact: Artifact) => void;
  onDelete: (artifact: Artifact) => void;
}
