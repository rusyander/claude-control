import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { Button } from './button';

/**
 * Кнопка — основной способ что-то сделать. Вид говорит о весе действия:
 * `primary` в блоке ровно одна, `danger` — только для разрушительного.
 */
const meta = {
  title: 'Компоненты/Button',
  component: Button,
  parameters: {
    docs: {
      description: {
        component:
          'Четыре вида и три размера. Вид выбирается по весу действия, а не по вкусу: ' +
          '`primary` — главное действие блока (оно одно), `secondary` — обычное, ' +
          '`ghost` — вспомогательное и всё, что живёт в строке списка, ' +
          '`danger` — удаление и прочее необратимое.',
      },
    },
  },
  args: { children: 'Сохранить' },
  argTypes: {
    variant: { control: 'select', options: ['primary', 'secondary', 'ghost', 'danger'] },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    isLoading: { control: 'boolean' },
    disabled: { control: 'boolean' },
    fullWidth: { control: 'boolean' },
    iconOnly: { control: 'boolean' },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычная: Story = {};

export const Виды: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Все четыре вида рядом — так видно разницу в весе.',
      },
    },
  },
  render: () => (
    <Stack direction="row" gap="var(--spacing-sm)" wrap align="center">
      <Button variant="primary">Сохранить</Button>
      <Button variant="secondary">Отмена</Button>
      <Button variant="ghost">Подробнее</Button>
      <Button variant="danger">Удалить</Button>
    </Stack>
  ),
};

export const Размеры: Story = {
  render: () => (
    <Stack direction="row" gap="var(--spacing-sm)" wrap align="center">
      <Button size="sm">Мелкая</Button>
      <Button size="md">Обычная</Button>
      <Button size="lg">Крупная</Button>
    </Stack>
  ),
};

export const СоЗначками: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Значок слева уточняет действие, справа — показывает направление. ' +
          'Оба сразу — перебор.',
      },
    },
  },
  render: () => (
    <Stack direction="row" gap="var(--spacing-sm)" wrap align="center">
      <Button leftIcon={<Icon name="plus" size={20} />}>Добавить правило</Button>
      <Button variant="secondary" rightIcon={<Icon name="chevronRight" size={20} />}>
        Дальше
      </Button>
      <Button variant="danger" leftIcon={<Icon name="trash" size={20} />}>
        Удалить
      </Button>
    </Stack>
  ),
};

export const ТолькоЗначок: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Кнопке без подписи `aria-label` обязателен — иначе для скринридера ' +
          'она безымянная. Рядом появляется подсказка браузера.',
      },
    },
  },
  render: () => (
    <Stack direction="row" gap="var(--spacing-sm)" wrap align="center">
      <Button
        variant="ghost"
        iconOnly
        icon={<Icon name="edit" size={24} />}
        aria-label="Изменить"
      />
      <Button
        variant="ghost"
        iconOnly
        icon={<Icon name="copy" size={24} />}
        aria-label="Копировать"
      />
      <Button
        variant="ghost"
        iconOnly
        icon={<Icon name="trash" size={24} />}
        aria-label="Удалить"
      />
      <Button
        variant="secondary"
        iconOnly
        icon={<Icon name="refresh" size={24} />}
        aria-label="Обновить"
      />
    </Stack>
  ),
};

export const Состояния: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Во время запроса кнопка занята: подпись остаётся на месте, чтобы блок ' +
          'не прыгал, а повторное нажатие не проходит.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-sm)">
      {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
        <Stack key={variant} direction="row" gap="var(--spacing-sm)" align="center" wrap>
          <Typography variant="caption" color="subtle" as="span" style={{ width: 90 }}>
            {variant}
          </Typography>
          <Button variant={variant}>Обычная</Button>
          <Button variant={variant} isLoading>
            Занята
          </Button>
          <Button variant={variant} disabled>
            Недоступна
          </Button>
        </Stack>
      ))}
    </Stack>
  ),
};

export const ВоВсюШирину: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Для форм в узкой колонке и нижних панелей окон.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-xs)" style={{ maxWidth: 360 }}>
      <Button fullWidth>Сохранить</Button>
      <Button variant="secondary" fullWidth>
        Отмена
      </Button>
    </Stack>
  ),
};
