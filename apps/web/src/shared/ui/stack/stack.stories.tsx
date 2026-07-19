import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Typography } from '@shared/ui/typography';
import { Stack } from './stack';

/**
 * Раскладка. Почти вся вёрстка приложения — это Stack: колонка или строка
 * с отступом из токенов.
 */
const meta = {
  title: 'Компоненты/Stack',
  component: Stack,
  parameters: {
    docs: {
      description: {
        component:
          'Обёртка над flexbox с отступами из токенов. Смысл в том, чтобы не ' +
          'заводить css-модуль ради «поставить в ряд с зазором»: такие блоки ' +
          'составляют большую часть разметки.\n\n' +
          'Значения отступов — только переменные (`var(--spacing-sm)`), ' +
          'иначе шкала расползается.',
      },
    },
  },
  args: { children: null },
  argTypes: {
    direction: { control: 'radio', options: ['row', 'column'] },
    align: { control: 'select', options: ['start', 'center', 'end', 'stretch', 'baseline'] },
    justify: { control: 'select', options: ['start', 'center', 'end', 'between', 'around'] },
    wrap: { control: 'boolean' },
  },
} satisfies Meta<typeof Stack>;

export default meta;
type Story = StoryObj<typeof meta>;

function Block({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: 'var(--spacing-sm) var(--spacing-md)',
        background: 'var(--color-accent-subtle)',
        border: '1px solid var(--color-accent)',
        borderRadius: 'var(--radius-md)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  );
}

export const Колонка: Story = {
  args: { gap: 'var(--spacing-sm)' },
  render: (args) => (
    <Stack {...args}>
      <Block>Первый</Block>
      <Block>Второй</Block>
      <Block>Третий</Block>
    </Stack>
  ),
};

export const Строка: Story = {
  args: { direction: 'row', gap: 'var(--spacing-sm)' },
  render: (args) => (
    <Stack {...args}>
      <Block>Первый</Block>
      <Block>Второй</Block>
      <Block>Третий</Block>
    </Stack>
  ),
};

export const Отступы: Story = {
  render: () => (
    <Stack gap="var(--spacing-lg)">
      {(['3xs', '2xs', 'xs', 'sm', 'md', 'lg'] as const).map((step) => (
        <Stack key={step} gap="var(--spacing-2xs)">
          <Typography variant="caption" color="subtle" as="span">
            gap: {step}
          </Typography>
          <Stack direction="row" gap={`var(--spacing-${step})`}>
            <Block>Раз</Block>
            <Block>Два</Block>
            <Block>Три</Block>
          </Stack>
        </Stack>
      ))}
    </Stack>
  ),
};

export const Выравнивание: Story = {
  parameters: {
    docs: {
      description: {
        story:
          '`justify="between"` разводит блок по краям — так устроена почти каждая строка списка.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-md)">
      {(['start', 'center', 'end', 'between', 'around'] as const).map((justify) => (
        <Stack key={justify} gap="var(--spacing-2xs)">
          <Typography variant="caption" color="subtle" as="span">
            justify: {justify}
          </Typography>
          <Card padding="sm">
            <Stack direction="row" justify={justify} gap="var(--spacing-xs)">
              <Block>Раз</Block>
              <Block>Два</Block>
            </Stack>
          </Card>
        </Stack>
      ))}
    </Stack>
  ),
};

export const СПереносом: Story = {
  parameters: {
    docs: {
      description: {
        story:
          '`wrap` обязателен там, где элементов заранее неизвестное число: ' +
          'значки статусов, кнопки фильтров. Без него строка выдавливает раскладку.',
      },
    },
  },
  render: () => (
    <Card padding="md" style={{ maxWidth: 420 }}>
      <Stack direction="row" gap="var(--spacing-xs)" wrap>
        {Array.from({ length: 9 }, (_, index) => (
          <Block key={index}>Элемент {index + 1}</Block>
        ))}
      </Stack>
    </Card>
  ),
};
