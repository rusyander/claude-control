import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import type { SideHeadProps } from './SideHead.types';

/** Шапка колонки: чей это столбец, из какого файла и почему он мог быть пуст. */
export function SideHead({ side }: SideHeadProps) {
  return (
    <Stack gap="2px">
      <Typography variant="body-sm" weight="medium">
        {side.providerName}
      </Typography>
      {side.filePath && (
        <Typography variant="caption" color="subtle">
          <TruncatedText text={side.filePath} />
        </Typography>
      )}
      {side.note && (
        <Typography variant="caption" color="subtle">
          {side.note}
        </Typography>
      )}
    </Stack>
  );
}
