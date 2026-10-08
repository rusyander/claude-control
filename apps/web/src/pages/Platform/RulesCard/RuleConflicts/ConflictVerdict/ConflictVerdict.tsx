import type { PlatformRuleConflict } from '@agentdeck/contracts';
import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { winnerKey } from '../../../lib/winnerKey';

/** Строка «кто берёт верх» или «спор снят выбором» под ячейкой матрицы. */
export function ConflictVerdict({ conflict }: { conflict: PlatformRuleConflict }) {
  const { t } = useTranslation();
  const winner = winnerKey(conflict);
  if (!conflict.offBy && !winner) return null;
  return (
    <Typography
      variant="caption"
      color={conflict.offBy ? 'muted' : 'default'}
      as="span"
      className="prose"
    >
      {conflict.offBy ? t(`contourConfig.offBy.${conflict.offBy}`) : winner && t(winner)}
    </Typography>
  );
}
