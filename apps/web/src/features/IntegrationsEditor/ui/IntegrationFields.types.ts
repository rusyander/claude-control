import type { IntegrationId } from '@agentdeck/contracts';
import type { IntegrationDraft } from '../model/draft';

export interface IntegrationFieldsProps {
  id: IntegrationId;
  draft: IntegrationDraft;
  onChange: (key: string, value: string) => void;
  /** Незаполненные обязательные поля — подсвечиваются подписью под полем. */
  missing: string[];
}
