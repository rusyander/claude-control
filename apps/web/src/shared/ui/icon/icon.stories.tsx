import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { ICON_PATHS, type IconName } from './icon.constants';
import { Icon } from './icon';

/**
 * Набор значков приложения. Все нарисованы одной сеткой и одной толщиной
 * линии, поэтому в строке они выглядят как одна семья.
 */
const meta = {
  title: 'Основы/Иконки',
  component: Icon,
  parameters: {
    docs: {
      description: {
        component:
          'Значки — часть кода, а не файлы: путь фигуры лежит в `icon.constants.ts`, ' +
          'поэтому цвет наследуется от текста, а размер задаётся числом.\n\n' +
          'Значок без подписи рядом ничего не сообщает скринридеру и по умолчанию ' +
          'скрыт от него. Если значок несёт смысл сам по себе — передайте `label`.',
      },
    },
  },
  args: { name: 'chat', size: 24 },
  argTypes: {
    name: { control: 'select', options: Object.keys(ICON_PATHS) },
    size: { control: { type: 'range', min: 12, max: 64, step: 2 } },
  },
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычный: Story = {};

export const ВесьНабор: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Все значки набора с именами — по ним они и подключаются.',
      },
    },
  },
  render: () => (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 'var(--spacing-xs)',
      }}
    >
      {(Object.keys(ICON_PATHS) as IconName[]).map((name) => (
        <Card key={name} padding="sm">
          <Stack align="center" gap="var(--spacing-2xs)">
            <Icon name={name} size={28} />
            <Typography variant="caption" color="subtle" as="span">
              {name}
            </Typography>
          </Stack>
        </Card>
      ))}
    </div>
  ),
};

export const Размеры: Story = {
  parameters: {
    docs: {
      description: {
        story:
          '**Шкала: 14 / 20 / 24 / 40.** 14 — в строку с мелким текстом, ' +
          '20 — внутри кнопок, 24 — в навигации, 40 — в пустых состояниях. ' +
          'Промежуточных значений нет намеренно: они не читаются как ' +
          'осмысленная разница, зато дают разнобой.\n\n' +
          'Внутри `Button` размер задавать не нужно — кнопка приводит значок ' +
          'к своему размеру сама (правило в `button.module.scss`). По приложению ' +
          'в кнопках встречалось пять разных размеров, и уследить за числом ' +
          'в каждом вызове оказалось невозможно.',
      },
    },
  },
  render: () => (
    <Stack direction="row" align="center" gap="var(--spacing-lg)" wrap>
      {[14, 20, 24, 32, 40].map((size) => (
        <Stack key={size} align="center" gap="var(--spacing-2xs)">
          <Icon name="skills" size={size} />
          <Typography variant="caption" color="subtle" as="span">
            {size}
          </Typography>
        </Stack>
      ))}
    </Stack>
  ),
};

export const Цвет: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'По умолчанию значок берёт цвет текста рядом — отдельно красить его ' +
          'обычно не нужно.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-sm)">
      {(['default', 'muted', 'subtle', 'accent', 'success', 'warning', 'danger'] as const).map(
        (color) => (
          <Typography key={color} color={color}>
            <Stack direction="row" align="center" gap="var(--spacing-xs)" as="span">
              <Icon name="warning" size={20} />
              наследует цвет текста — {color}
            </Stack>
          </Typography>
        ),
      )}
    </Stack>
  ),
};
