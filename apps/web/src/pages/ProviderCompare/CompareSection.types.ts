import type { CompareSectionResult, ProviderMigrateRequest } from '@claude-control/contracts';

export interface CompareSectionProps {
  section: CompareSectionResult;
  busy: boolean;
  onMigrate: (request: ProviderMigrateRequest) => void;
}
