import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TruncatedText } from '@shared/ui/truncated-text';
import type { SideHeadProps } from './SideHead.types';

/**
 * Шапка колонки: чей это столбец, из какого файла и почему он мог быть пуст.
 *
 * Путь к файлу — прямой потомок колонки (flex), а не строка внутри абзаца:
 * обрезка многоточием работает только у блочного элемента, и вложенный в
 * inline-абзац путь вылезал за ячейку — два длинных Windows-пути налезали друг
 * на друга. Полный путь остаётся в подсказке.
 */
export function SideHead({ side }: SideHeadProps) {
  return (
    <Stack gap="2px">
      <Typography variant="body-sm" weight="medium">
        {side.providerName}
      </Typography>
      {side.filePath && <TruncatedText text={side.filePath} variant="caption" color="subtle" />}
      {side.note && (
        <Typography variant="caption" color="subtle">
          {side.note}
        </Typography>
      )}
    </Stack>
  );
}
