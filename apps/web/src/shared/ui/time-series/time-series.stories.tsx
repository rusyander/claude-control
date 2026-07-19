import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TimeSeries } from './time-series';

/** График по дням: как менялся расход за период. */
const meta = {
  title: 'Данные/TimeSeries',
  component: TimeSeries,
  parameters: {
    docs: {
      description: {
        component:
          'Линия с заливкой под ней: показывает и форму изменения, и объём. ' +
          'Название ряда подставляется во всплывающую подсказку, поэтому ' +
          'отдельная легенда не нужна — она заняла бы место ради одной строки.',
      },
    },
  },
  args: {
    seriesName: 'Все токены',
    points: buildPoints(30),
  },
  argTypes: {
    height: { control: { type: 'range', min: 80, max: 400, step: 20 } },
  },
} satisfies Meta<typeof TimeSeries>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Ряд с заметными пиками — как настоящий расход по дням. */
function buildPoints(days: number) {
  const shape = [
    3, 1, 4, 2, 6, 3, 2, 3, 9, 4, 2, 5, 3, 7, 4, 8, 5, 3, 6, 4, 2, 5, 8, 3, 6, 4, 7, 3, 5, 2,
  ];

  // Даты идут подряд от начала июня — без повторов, иначе подписи оси
  // на месяце данных начинают дублироваться.
  const start = new Date(2026, 5, 20);

  return Array.from({ length: days }, (_, index) => {
    const value = (shape[index % shape.length] ?? 3) * 120_000_000;
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const label = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    return { label, value, valueLabel: `${(value / 1_000_000_000).toFixed(1)} млрд` };
  });
}

export const Обычный: Story = {};

export const ВКарточке: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Как график стоит на странице аналитики.',
      },
    },
  },
  render: (args) => (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)">
          <Typography variant="body" weight="medium">
            Расход по дням
          </Typography>
          <Typography variant="caption" color="subtle">
            Все токены: вход, выход и работа с кэшем
          </Typography>
        </Stack>
        <TimeSeries {...args} />
      </Stack>
    </Card>
  ),
};

export const КороткийПериод: Story = {
  args: { points: buildPoints(7) },
};

export const Низкий: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Уменьшенная высота — для случаев, когда график идёт вспомогательным блоком.',
      },
    },
  },
  args: { height: 120 },
};

export const ОдинДень: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Крайний случай: одна точка. Линию строить не из чего, но блок не ломается.',
      },
    },
  },
  args: {
    points: [{ label: '07-19', value: 420_000_000, valueLabel: '0,4 млрд' }],
  },
};
