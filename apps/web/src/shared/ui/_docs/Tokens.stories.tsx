import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';

/**
 * Токены оформления — единственный источник цветов, отступов и шрифтов.
 * Образцы рисуются самими переменными, поэтому список не может разойтись
 * с реальностью: если токен переименуют, здесь появится пустое место.
 */
const meta = {
  title: 'Основы/Токены',
  parameters: {
    docs: {
      description: {
        component:
          'Значения из `shared/styles/global.scss`. Переключите тему в панели сверху — ' +
          'цвета пересчитаются: в токенах и лежит вся разница между светлой и тёмной.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const COLORS = [
  ['--color-bg', 'фон страницы'],
  ['--color-surface', 'поверхность карточки'],
  ['--color-surface-raised', 'приподнятая поверхность'],
  ['--color-surface-sunken', 'утопленная поверхность'],
  ['--color-border', 'граница'],
  ['--color-border-strong', 'граница при наведении'],
  ['--color-fg', 'основной текст'],
  ['--color-fg-muted', 'второстепенный текст'],
  ['--color-fg-subtle', 'подписи'],
  ['--color-accent', 'акцент'],
  ['--color-accent-hover', 'акцент при наведении'],
  ['--color-accent-subtle', 'подложка акцента'],
  ['--color-success', 'успех'],
  ['--color-warning', 'предупреждение'],
  ['--color-danger', 'опасность'],
  ['--color-info', 'справка'],
];

const SPACING = ['3xs', '2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'];
const RADII = ['sm', 'md', 'lg', 'full'];
const SHADOWS = ['sm', 'md', 'lg'];

export const Цвета: Story = {
  render: () => (
    <Stack gap="var(--spacing-xs)">
      {COLORS.map(([token, description]) => (
        <Card key={token} padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-md)">
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 'var(--radius-md)',
                background: `var(${token})`,
                border: '1px solid var(--color-border)',
                flexShrink: 0,
              }}
            />
            <Stack gap="var(--spacing-3xs)">
              <Typography variant="mono" as="span">
                {token}
              </Typography>
              <Typography variant="caption" color="subtle" as="span">
                {description}
              </Typography>
            </Stack>
          </Stack>
        </Card>
      ))}
    </Stack>
  ),
};

export const Отступы: Story = {
  render: () => (
    <Stack gap="var(--spacing-sm)">
      {SPACING.map((step) => (
        <Stack key={step} direction="row" align="center" gap="var(--spacing-md)">
          <Typography variant="mono" as="span" style={{ width: 180 }}>
            --spacing-{step}
          </Typography>
          <div
            style={{
              height: 16,
              width: `var(--spacing-${step})`,
              background: 'var(--color-accent)',
              borderRadius: 'var(--radius-sm)',
            }}
          />
        </Stack>
      ))}
    </Stack>
  ),
};

export const Радиусы: Story = {
  render: () => (
    <Stack direction="row" gap="var(--spacing-md)" wrap>
      {RADII.map((step) => (
        <Stack key={step} gap="var(--spacing-2xs)" align="center">
          <div
            style={{
              width: 84,
              height: 84,
              background: 'var(--color-accent-subtle)',
              border: '1px solid var(--color-accent)',
              borderRadius: `var(--radius-${step})`,
            }}
          />
          <Typography variant="caption" color="subtle" as="span">
            {step}
          </Typography>
        </Stack>
      ))}
    </Stack>
  ),
};

export const Тени: Story = {
  render: () => (
    <Stack direction="row" gap="var(--spacing-lg)" wrap>
      {SHADOWS.map((step) => (
        <Stack key={step} gap="var(--spacing-2xs)" align="center">
          <div
            style={{
              width: 120,
              height: 84,
              background: 'var(--color-surface-raised)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: `var(--shadow-${step})`,
            }}
          />
          <Typography variant="caption" color="subtle" as="span">
            shadow-{step}
          </Typography>
        </Stack>
      ))}
    </Stack>
  ),
};

export const Шрифты: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Шкала целиком. Включите «Крупный текст» в панели сверху — размеры вырастут: ' +
          'режим доступности меняет именно эти токены, а не масштаб страницы.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-sm)">
      {(
        [
          'heading-lg',
          'heading',
          'heading-sm',
          'body-lg',
          'body',
          'body-sm',
          'caption',
          'mono',
        ] as const
      ).map((variant) => (
        <Stack key={variant} gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {variant}
          </Typography>
          <Typography variant={variant}>Съешь ещё этих мягких булок — 0123456789</Typography>
        </Stack>
      ))}
    </Stack>
  ),
};
