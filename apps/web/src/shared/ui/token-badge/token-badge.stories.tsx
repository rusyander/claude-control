import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { TokenBadge } from './token-badge';

/**
 * Цена одного действия агента. Стоит рядом со строкой действия в ленте чата и
 * раскрывается по наведению.
 */
const meta = {
  title: 'Компоненты/TokenBadge',
  component: TokenBadge,
  parameters: {
    docs: {
      description: {
        component:
          'Два числа вместо одного — намеренно. Полный объём шага почти всегда ' +
          'равен размеру контекста и состоит в основном из чтения кэша, поэтому ' +
          'по нему нельзя отличить дешёвое действие от дорогого. Приглушённое ' +
          'число — весь объём, акцентное — новая работа шага (свежий вход, ' +
          'запись в кэш, генерация); она и стоит денег.\n\n' +
          'Раскрытие по наведению, а не по клику: цифра справочная. Клик ' +
          'закрепляет панель, Escape и клик мимо её снимают.',
      },
    },
  },
  args: {
    usage: {
      input: 620,
      output: 1180,
      cacheRead: 46_400,
      cacheCreation: 2100,
      model: 'claude-opus-4-8',
      costUsd: 0.0412,
    },
  },
  argTypes: {
    unit: { control: 'inline-radio', options: ['tokens', 'money'] },
    sharedWith: { control: { type: 'number', min: 1, max: 5 } },
  },
} satisfies Meta<typeof TokenBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычный: Story = {};

export const ВДеньгах: Story = { args: { unit: 'money' } };

/** Шаг с параллельными вызовами: расход у них общий, и панель это говорит. */
export const ОбщийНаНесколькоВызовов: Story = {
  args: { sharedWith: 3, label: 'Bash', effort: 'high' },
};

/** Первый шаг разговора: кэша ещё нет, почти всё уходит в запись. */
export const ХолодныйКэш: Story = {
  args: {
    usage: {
      input: 14_200,
      output: 340,
      cacheRead: 0,
      cacheCreation: 31_800,
      model: 'claude-sonnet-5',
      costUsd: 0.0631,
    },
  },
};

export const ВЛенте: Story = {
  render: (args) => (
    <Stack gap="var(--spacing-sm)" style={{ maxWidth: 520 }}>
      {['Write', 'Edit', 'Bash'].map((name) => (
        <Stack key={name} direction="row" align="center" gap="var(--spacing-sm)">
          <Typography
            variant="body"
            style={{
              flex: 1,
              padding: 'var(--spacing-xs) var(--spacing-sm)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {name}
          </Typography>
          <TokenBadge {...args} label={name} />
        </Stack>
      ))}
    </Stack>
  ),
};
