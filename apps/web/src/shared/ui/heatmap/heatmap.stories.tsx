import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Heatmap } from './heatmap';
import type { HeatmapCell } from './heatmap.types';

/**
 * Тепловая шкала: величина кодируется насыщенностью одного тона. Применяется
 * там, где важен не точный отсчёт, а рисунок распределения — например,
 * активность по часам суток.
 */
const meta = {
  title: 'Данные/Heatmap',
  component: Heatmap,
  parameters: {
    docs: {
      description: {
        component:
          'Один тон, светлее→насыщеннее — это последовательная шкала: цвет ' +
          'показывает величину, а не категорию. Точное значение читается по ' +
          'наведению, а подписи оси прорежены, чтобы 24 часа поместились.',
      },
    },
  },
  args: {
    ariaLabel: 'Активность по часам',
    columns: 24,
    scale: { min: 'меньше', max: 'больше' },
  },
} satisfies Meta<typeof Heatmap>;

export default meta;
type Story = StoryObj<typeof meta>;

// Суточный ритм: ночью тихо, днём и вечером пики.
const hourly: HeatmapCell[] = Array.from({ length: 24 }, (_, hour) => {
  const shape = hour >= 9 && hour <= 22 ? Math.round(40 + 60 * Math.sin((hour - 6) / 5)) : 2;
  const value = Math.max(0, shape);
  return {
    id: String(hour),
    label: `${hour}:00`,
    value,
    valueLabel: `${value} запросов`,
  };
});

export const ПоЧасам: Story = {
  args: { cells: hourly },
  render: (args) => (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          Активность по часам суток
        </Typography>
        <Heatmap {...args} />
      </Stack>
    </Card>
  ),
};
