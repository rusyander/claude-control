import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Typography } from './typography';

/**
 * Весь текст приложения идёт через этот компонент: он держит шкалу размеров,
 * цвета из токенов и правильный семантический тег.
 */
const meta = {
  title: 'Компоненты/Typography',
  component: Typography,
  parameters: {
    docs: {
      description: {
        component:
          'Размер и цвет выбираются из наборов — свободных значений нет. ' +
          'Тег задаётся отдельно (`as`): размер текста и его роль в разметке — ' +
          'разные вещи, и подпись поля вполне может выглядеть как обычный текст.\n\n' +
          'Цвет тоже несёт смысл: `muted` — второстепенное, `subtle` — подписи ' +
          'и служебное, `danger` — ошибка. Раскрашивать текст «для красоты» нечем, ' +
          'и это намеренно.',
      },
    },
  },
  args: { children: 'Съешь ещё этих мягких булок' },
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'heading-lg',
        'heading',
        'heading-sm',
        'body-lg',
        'body',
        'body-sm',
        'caption',
        'mono',
      ],
    },
    color: {
      control: 'select',
      options: [
        'default',
        'muted',
        'subtle',
        'accent',
        'success',
        'warning',
        'danger',
        'info',
        'inverse',
      ],
    },
    weight: { control: 'select', options: ['regular', 'medium', 'semibold'] },
    align: { control: 'select', options: ['left', 'center', 'right'] },
    truncate: { control: 'boolean' },
  },
} satisfies Meta<typeof Typography>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычный: Story = {};

export const Шкала: Story = {
  render: () => (
    <Stack gap="var(--spacing-sm)">
      {(
        [
          ['heading-lg', 'заголовок страницы'],
          ['heading', 'крупный раздел'],
          ['heading-sm', 'заголовок блока и окна'],
          ['body-lg', 'крупный текст'],
          ['body', 'основной текст'],
          ['body-sm', 'мелкий текст, подписи полей'],
          ['caption', 'служебное: даты, счётчики'],
          ['mono', 'пути, команды, идентификаторы'],
        ] as const
      ).map(([variant, purpose]) => (
        <Stack key={variant} gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {variant} — {purpose}
          </Typography>
          <Typography variant={variant}>Съешь ещё этих мягких булок — 0123456789</Typography>
        </Stack>
      ))}
    </Stack>
  ),
};

export const Цвета: Story = {
  render: () => (
    <Stack gap="var(--spacing-2xs)">
      {(
        [
          ['default', 'обычный текст'],
          ['muted', 'второстепенное'],
          ['subtle', 'подписи и служебное'],
          ['accent', 'ссылки и выделенное'],
          ['success', 'получилось'],
          ['warning', 'требует внимания'],
          ['danger', 'ошибка'],
          ['info', 'справочное'],
        ] as const
      ).map(([color, purpose]) => (
        <Typography key={color} color={color}>
          {color} — {purpose}
        </Typography>
      ))}
      <Card padding="sm" style={{ background: 'var(--color-accent)' }}>
        <Typography color="inverse">inverse — текст на залитой подложке</Typography>
      </Card>
    </Stack>
  ),
};

export const Начертания: Story = {
  render: () => (
    <Stack gap="var(--spacing-2xs)">
      <Typography weight="regular">regular — обычное</Typography>
      <Typography weight="medium">medium — выделяет название в строке</Typography>
      <Typography weight="semibold">semibold — заголовки</Typography>
    </Stack>
  ),
};

export const ДлинныйТекст: Story = {
  parameters: {
    docs: {
      description: {
        story:
          '`truncate` обрезает в одну строку многоточием, `clamp` — по числу строк. ' +
          'Нужно там, где текст приходит от пользователя и длину предсказать нельзя: ' +
          'пути, названия чатов, описания скиллов.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-md)" style={{ maxWidth: 420 }}>
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="caption" color="subtle" as="span">
          без ограничений
        </Typography>
        <Typography variant="mono">
          C:\Users\rusyander\AppData\Local\Temp\claude\c--work-claude-control\scratchpad\dirA
        </Typography>
      </Stack>

      <Stack gap="var(--spacing-3xs)">
        <Typography variant="caption" color="subtle" as="span">
          truncate
        </Typography>
        <Typography variant="mono" truncate>
          C:\Users\rusyander\AppData\Local\Temp\claude\c--work-claude-control\scratchpad\dirA
        </Typography>
      </Stack>

      <Stack gap="var(--spacing-3xs)">
        <Typography variant="caption" color="subtle" as="span">
          clamp=2
        </Typography>
        <Typography clamp={2}>
          Use КОГДА пользователь просит проверить доступность интерфейса («аудит a11y», «доступность
          страницы», «проверь клавиатурную навигацию») — аудит фронта: axe-core через Playwright,
          клавиатурный обход, контраст, семантика.
        </Typography>
      </Stack>
    </Stack>
  ),
};
