import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import type { StepSourceKind } from '../model/stepSource';
import type { SourceChipProps } from './SourceChip.types';

const TONES: Record<StepSourceKind, BadgeTone> = {
  builtin: 'neutral',
  'our-skill': 'info',
  'project-skill': 'info',
  'plugin-skill': 'info',
  'foreign-skill': 'warning',
  skill: 'info',
  prompt: 'success',
  hook: 'accent',
  rule: 'accent',
  script: 'accent',
};

/** Метка «откуда строка»: наш скилл, скилл проекта, плагина, чужой, промпт панели, хук, правило. */
export function SourceChip({ source }: SourceChipProps) {
  const { t } = useTranslation();
  const label = t(`groupPath.source.${source.kind}`);
  return (
    <Badge tone={TONES[source.kind]}>
      {source.id ? t('groupPath.sourceChip', { source: label, id: source.id }) : label}
    </Badge>
  );
}
