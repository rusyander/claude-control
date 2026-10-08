import type { CompareSectionResult, ProviderMigrateRequest } from '@agentdeck/contracts';

export interface CompareSectionProps {
  section: CompareSectionResult;
  busy: boolean;
  onMigrate: (request: ProviderMigrateRequest) => void;
}
