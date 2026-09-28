import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@shared/ui/badge';
import type { RowType } from '../model/rowWords';
import type { TypeChipProps } from './TypeChip.types';

const TONES: Record<RowType, BadgeTone> = {
  stage: 'neutral',
  'our-skill': 'info',
  'foreign-skill': 'warning',
  prompt: 'success',
  hook: 'accent',
  rule: 'accent',
  script: 'neutral',
};

/**
 * Вид строки одним словом: наш скилл, чужой скилл, промпт, хук, правило,
 * утилита. Подробности «откуда» — в окне шага; в строке хватает вида: при
 * восьмидесяти шагах длинная метка съедала бы название.
 */
export function TypeChip({ type }: TypeChipProps) {
  const { t } = useTranslation();
  return (
    <span title={t(`groupBuilder.typeHint.${type}`)}>
      <Badge tone={TONES[type]}>{t(`groupBuilder.type.${type}`)}</Badge>
    </span>
  );
}
