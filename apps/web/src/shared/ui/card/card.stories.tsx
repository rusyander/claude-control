import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Card } from './card';

/**
 * Карточка — единая рамка для всех блоков приложения. Одинаковая по всему
 * проекту: рамка, радиус и внутренний отступ приходят отсюда, а не задаются
 * на местах.
 */
const meta = {
  title: 'Компоненты/Card',
  component: Card,
  parameters: {
    docs: {
      description: {
        component:
          'Контейнер с общей рамкой, радиусом и тенью. Отступ выбирается из набора, ' +
          'а не задаётся числом на месте — иначе карточки по приложению разъезжаются.\n\n' +
          '`md` — обычное значение и почти всегда верное. `none` — когда внутри ' +
          'список со своими отступами и рамка нужна только снаружи. ' +
          '`lg` — крупные блоки на просторных страницах.',
      },
    },
  },
  args: { children: 'Содержимое карточки' },
  argTypes: {
    padding: { control: 'select', options: ['none', 'sm', 'md', 'lg'] },
    isRaised: { control: 'boolean' },
    isInteractive: { control: 'boolean' },
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычная: Story = {};

export const Отступы: Story = {
  render: () => (
    <Stack gap="var(--spacing-sm)">
      {(['none', 'sm', 'md', 'lg'] as const).map((padding) => (
        <Card key={padding} padding={padding}>
          <div style={{ background: 'var(--color-accent-subtle)', borderRadius: 4 }}>
            <Typography variant="body-sm">padding=«{padding}»</Typography>
          </div>
        </Card>
      ))}
    </Stack>
  ),
};

export const Приподнятая: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Для выделенных и активных блоков: чуть светлее фон и мягкая тень.',
      },
    },
  },
  render: () => (
    <Stack direction="row" gap="var(--spacing-md)" wrap>
      <Card padding="md" style={{ width: 260 }}>
        <Typography variant="body-sm">Обычная</Typography>
      </Card>
      <Card padding="md" isRaised style={{ width: 260 }}>
        <Typography variant="body-sm">Приподнятая</Typography>
      </Card>
    </Stack>
  ),
};

export const Интерактивная: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Реагирует на наведение — так видно, что карточка ведёт куда-то дальше. ' +
          'Без этого признака кликабельную плитку не отличить от обычной.',
      },
    },
  },
  render: () => (
    <Stack direction="row" gap="var(--spacing-md)" wrap>
      <Card padding="md" isInteractive style={{ width: 240 }}>
        <Stack gap="var(--spacing-2xs)">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="rules" size={20} />
            <Typography variant="body-sm" color="muted" as="span">
              Правила
            </Typography>
          </Stack>
          <Typography variant="heading">13</Typography>
          <Typography variant="caption" color="subtle" as="span">
            13 включено
          </Typography>
        </Stack>
      </Card>
    </Stack>
  ),
};

export const ВЖизни: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Строка списка: название со значками слева, действия справа.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-xs)" style={{ maxWidth: 720 }}>
      <Card padding="md">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-md)" wrap>
          <Stack gap="var(--spacing-2xs)">
            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Typography variant="body" weight="medium" as="span">
                Правка файлов
              </Typography>
              <Badge tone="warning">средний риск</Badge>
            </Stack>
            <Typography variant="body-sm" color="muted">
              Изменение существующих файлов.
            </Typography>
            <Typography variant="mono" color="subtle" as="span">
              Edit
            </Typography>
          </Stack>

          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Typography variant="body-sm" color="subtle" as="span">
              Не задано
            </Typography>
            <Button size="sm" variant="secondary" leftIcon={<Icon name="plus" size={20} />}>
              Настроить
            </Button>
          </Stack>
        </Stack>
      </Card>
    </Stack>
  ),
};
