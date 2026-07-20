import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Skeleton } from './Skeleton';
import { SkeletonList } from './SkeletonList';
import { SkeletonTiles } from './SkeletonTiles';
import { SkeletonChart } from './SkeletonChart';

/**
 * Заглушка на время загрузки. Держит место будущего содержимого, чтобы
 * страница не прыгала, когда данные приедут.
 */
const meta = {
  title: 'Данные/Skeleton',
  component: Skeleton,
  parameters: {
    docs: {
      description: {
        component:
          'Заглушка вместо крутящегося колёсика: она занимает столько же места, ' +
          'сколько займут данные, поэтому при их появлении раскладка не дёргается.\n\n' +
          'Правило простое: форма заглушки должна повторять форму содержимого. ' +
          'Если вместо списка строк показать один серый прямоугольник, ' +
          'страница всё равно прыгнет.',
      },
    },
  },
  args: { width: 240, height: 16 },
  argTypes: {
    radius: { control: 'select', options: ['sm', 'md', 'full'] },
  },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычная: Story = {};

export const Формы: Story = {
  render: () => (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle" as="span">
          строка текста
        </Typography>
        <Skeleton width={320} height={14} />
      </Stack>

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle" as="span">
          заголовок
        </Typography>
        <Skeleton width={200} height={24} />
      </Stack>

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle" as="span">
          аватар / значок
        </Typography>
        <Skeleton width={40} height={40} radius="full" />
      </Stack>

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle" as="span">
          блок
        </Typography>
        <Skeleton width="100%" height={96} radius="md" />
      </Stack>
    </Stack>
  ),
};

export const СписокСтрок: Story = {
  parameters: {
    docs: {
      description: {
        story:
          '`SkeletonList` — готовая заглушка для списков приложения. ' +
          '`withActions` добавляет справа заглушки кнопок и переключателя, ' +
          'как в списках скиллов, хуков и плагинов.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-lg)">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle" as="span">
          withActions (по умолчанию)
        </Typography>
        <SkeletonList rows={3} />
      </Stack>

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle" as="span">
          без действий
        </Typography>
        <SkeletonList rows={3} withActions={false} />
      </Stack>
    </Stack>
  ),
};

export const ПлиткиИГрафик: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Заглушки под конкретные блоки: ряд плиток на обзоре и график на ' +
          'аналитике. Они повторяют раскладку настоящих блоков.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-lg)">
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle" as="span">
          SkeletonTiles
        </Typography>
        <SkeletonTiles count={4} />
      </Stack>

      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle" as="span">
          SkeletonChart
        </Typography>
        <SkeletonChart />
      </Stack>
    </Stack>
  ),
};
