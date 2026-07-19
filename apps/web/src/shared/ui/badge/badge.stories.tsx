import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from './badge';

/**
 * Значок — короткий статус рядом с названием. Именно статус: если по нему
 * можно нажать, это кнопка, а не значок.
 */
const meta = {
  title: 'Компоненты/Badge',
  component: Badge,
  parameters: {
    docs: {
      description: {
        component:
          'Короткий статус: включено, риск, режим. Тон несёт смысл, поэтому цвет ' +
          'выбирается по значению, а не по красоте: `success` — хорошо, ' +
          '`warning` — требует внимания, `danger` — опасно, `info` — справочное, ' +
          '`neutral` — просто метка.\n\n' +
          'Значок не бывает интерактивным. Залитая плашка рядом с кнопкой сама ' +
          'читается кнопкой — это уже приводило к путанице на странице прав.',
      },
    },
  },
  args: { children: 'включено' },
  argTypes: {
    tone: {
      control: 'select',
      options: ['neutral', 'accent', 'success', 'warning', 'danger', 'info'],
    },
    withDot: { control: 'boolean' },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычный: Story = {};

export const Тона: Story = {
  render: () => (
    <Stack direction="row" gap="var(--spacing-xs)" wrap align="center">
      <Badge tone="neutral">черновик</Badge>
      <Badge tone="accent">выбрано</Badge>
      <Badge tone="success">включено</Badge>
      <Badge tone="warning">спрашивать</Badge>
      <Badge tone="danger">запрещено</Badge>
      <Badge tone="info">справка</Badge>
    </Stack>
  ),
};

export const СТочкой: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Точка нужна там, где значок сообщает о живом состоянии: сколько ' +
          'процессов работает, включён ли сервер. Она отличает состояние ' +
          'от простой метки.',
      },
    },
  },
  render: () => (
    <Stack direction="row" gap="var(--spacing-xs)" wrap align="center">
      <Badge tone="success" withDot>
        9
      </Badge>
      <Badge tone="success" withDot>
        Разрешено: 119
      </Badge>
      <Badge tone="warning" withDot>
        Спрашивать: 0
      </Badge>
      <Badge tone="danger" withDot>
        Запрещено: 7
      </Badge>
    </Stack>
  ),
};

export const ВЖизни: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Как значки выглядят в строке списка — рядом с названием и подписью.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-sm)">
      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
        <Typography variant="body" weight="medium" as="span">
          Любые команды оболочки
        </Typography>
        <Badge tone="danger">высокий риск</Badge>
      </Stack>
      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
        <Typography variant="body" weight="medium" as="span">
          Чтение любых файлов
        </Typography>
        <Badge tone="success">низкий риск</Badge>
      </Stack>
      <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
        <Typography variant="body" weight="medium" as="span">
          code-simplifier
        </Typography>
        <Badge tone="neutral">claude-plugins-official</Badge>
        <Badge tone="info">версия 1.0.0</Badge>
      </Stack>
    </Stack>
  ),
};
