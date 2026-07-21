import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { DonutChart } from './donut-chart';

/**
 * Кольцевая диаграмма состава: доли одного целого с итоговым показателем в
 * центре. Применяется, когда сегментов немного, — например, из чего сложился
 * расход токенов и какая часть пришла из кэша.
 */
const meta = {
  title: 'Данные/DonutChart',
  component: DonutChart,
  parameters: {
    docs: {
      description: {
        component:
          'Точные величины и проценты продублированы легендой, поэтому чтение не ' +
          'зависит от оценки угла на глаз. Цвет закреплён за категорией и не ' +
          'переставляется по величине. Наведение подсвечивает сегмент и его строку.',
      },
    },
  },
  args: {
    ariaLabel: 'Состав расхода токенов',
    centerValue: '38%',
    centerLabel: 'из кэша',
    segments: [
      {
        id: 'cacheRead',
        label: 'Чтение кэша',
        value: 3_800_000,
        valueLabel: '3,8 млн',
        seriesIndex: 3,
      },
      {
        id: 'input',
        label: 'Входные токены',
        value: 2_100_000,
        valueLabel: '2,1 млн',
        seriesIndex: 1,
      },
      {
        id: 'output',
        label: 'Сгенерировано',
        value: 1_400_000,
        valueLabel: '1,4 млн',
        seriesIndex: 2,
      },
      {
        id: 'cacheCreation',
        label: 'Запись кэша',
        value: 900_000,
        valueLabel: '900 тыс.',
        seriesIndex: 4,
      },
    ],
  },
} satisfies Meta<typeof DonutChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const СоставКэша: Story = {
  render: (args) => (
    <Card padding="md" style={{ maxWidth: 520 }}>
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          Состав расхода токенов
        </Typography>
        <DonutChart {...args} />
      </Stack>
    </Card>
  ),
};
