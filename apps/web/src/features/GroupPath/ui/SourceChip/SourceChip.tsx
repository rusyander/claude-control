import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import type { SourceChipProps } from './SourceChip.types';
import { TONES } from './SourceChip.constants';

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
