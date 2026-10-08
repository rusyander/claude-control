import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import type { TypeChipProps } from './TypeChip.types';
import { TONES } from './TypeChip.constants';

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
