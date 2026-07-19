import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { BarChart } from './bar-chart';

/**
 * Горизонтальные полосы для сравнения величин: расход по моделям, по проектам.
 * Подписи значений стоят всегда — читать график наведением неудобно.
 */
const meta = {
  title: 'Данные/BarChart',
  component: BarChart,
  parameters: {
    docs: {
      description: {
        component:
          'Горизонтальные полосы выбраны не случайно: подписи здесь длинные — ' +
          'имена моделей и пути проектов, — и в вертикальных столбцах они бы ' +
          'не поместились.\n\n' +
          'Значение подписано рядом с полосой и видно сразу. Хвост сворачивается ' +
          'в «Прочее», иначе список из сорока проектов забивает страницу.',
      },
    },
  },
  args: {
    items: [
      { id: '1', label: 'claude-opus-4-8', value: 18_700_000_000, valueLabel: '18,7 млрд' },
      { id: '2', label: 'claude-fable-5', value: 3_500_000_000, valueLabel: '3,5 млрд' },
      { id: '3', label: 'claude-opus-4-7', value: 14_300_000, valueLabel: '14,3 млн' },
      { id: '4', label: 'claude-haiku-4-5', value: 2_100_000, valueLabel: '2,1 млн' },
    ],
  },
} satisfies Meta<typeof BarChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычный: Story = {};

export const ВКарточке: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Как график живёт на странице аналитики — внутри карточки с заголовком.',
      },
    },
  },
  render: (args) => (
    <Card padding="md" style={{ maxWidth: 560 }}>
      <Stack gap="var(--spacing-sm)">
        <Typography variant="body" weight="medium">
          По моделям
        </Typography>
        <BarChart {...args} />
      </Stack>
    </Card>
  ),
};

export const СоСворачиванием: Story = {
  parameters: {
    docs: {
      description: {
        story:
          '`limit` оставляет первые строки, остальные складывает в «Прочее». ' +
          'Так видно и лидеров, и общий объём хвоста.',
      },
    },
  },
  args: {
    limit: 4,
    otherLabel: 'Прочее',
    items: [
      { id: '1', label: 'apps-view-sdk/widget', value: 8_800_000_000, valueLabel: '8,8 млрд' },
      { id: '2', label: 'nis/apps-view-sdk', value: 3_300_000_000, valueLabel: '3,3 млрд' },
      { id: '3', label: 'nis/helpdesk-frontend', value: 2_700_000_000, valueLabel: '2,7 млрд' },
      { id: '4', label: 'my_projects/train', value: 1_600_000_000, valueLabel: '1,6 млрд' },
      { id: '5', label: 'claude-control', value: 900_000_000, valueLabel: '900 млн' },
      { id: '6', label: 'docs-ai', value: 600_000_000, valueLabel: '600 млн' },
      { id: '7', label: 'gorgona', value: 400_000_000, valueLabel: '400 млн' },
    ],
  },
};

export const Интерактивный: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'С обработчиком строки становятся кликабельными и открывают подробности. ' +
          'Без него график только показывает — и не притворяется кнопкой.',
      },
    },
  },
  args: {
    onItemClick: (id: string) => window.alert(`Открыть подробности: ${id}`),
  },
};

export const ОдноЗначение: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Крайний случай: одна строка занимает всю ширину — это нормально.',
      },
    },
  },
  args: {
    items: [{ id: '1', label: 'claude-opus-4-8', value: 100, valueLabel: '22,2 млрд' }],
  },
};
