import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { ResizeHandle } from './resize-handle';

/**
 * Разделитель между колонками: тянется мышью и клавиатурой. Ширина, которую
 * пользователь выбрал, обычно запоминается — под страницу нужна одна,
 * под код другая.
 */
const meta = {
  title: 'Компоненты/ResizeHandle',
  component: ResizeHandle,
  parameters: {
    docs: {
      description: {
        component:
          'Полоса между колонками. Тянется мышью, а стрелками влево-вправо — ' +
          'с клавиатуры: перетаскивание, доступное только мышью, для части ' +
          'пользователей означает «недоступно вовсе».\n\n' +
          '`min` и `max` держат колонку в разумных пределах: без них соседнюю ' +
          'панель можно схлопнуть в ноль и потом не найти.',
      },
    },
  },
  args: {
    width: 320,
    onResize: () => undefined,
    label: 'Изменить ширину превью',
    min: 220,
    max: 620,
  },
} satisfies Meta<typeof ResizeHandle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ВРаскладке: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Потяните разделитель — правая колонка меняет ширину. Так устроен ' +
          'предпросмотр артефактов в чате.',
      },
    },
  },
  render: function Render(args) {
    const [width, setWidth] = useState(args.width);

    return (
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle">
          Ширина правой колонки: {width} px
        </Typography>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(0, 1fr) auto ${width}px`,
            height: 320,
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          <Card padding="md" style={{ border: 'none', borderRadius: 0 }}>
            <Typography variant="body-sm" color="muted">
              Лента разговора
            </Typography>
          </Card>

          <ResizeHandle {...args} width={width} onResize={setWidth} />

          <Card
            padding="md"
            style={{ border: 'none', borderRadius: 0, background: 'var(--color-surface-sunken)' }}
          >
            <Typography variant="body-sm" color="muted">
              Предпросмотр
            </Typography>
          </Card>
        </div>
      </Stack>
    );
  },
};

export const СКлавиатуры: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Наведите фокус табом и нажимайте стрелки влево-вправо — ширина ' +
          'меняется шагами. Значение объявляется скринридеру.',
      },
    },
  },
  render: function Render(args) {
    const [width, setWidth] = useState(300);

    return (
      <Stack direction="row" align="stretch" gap="0" style={{ height: 200 }}>
        <Card padding="md" style={{ flex: 1 }}>
          <Typography variant="body-sm" color="muted">
            Таб приводит фокус на разделитель
          </Typography>
        </Card>
        <ResizeHandle {...args} width={width} onResize={setWidth} />
        <Card padding="md" style={{ width }}>
          <Typography variant="body-sm">{width} px</Typography>
        </Card>
      </Stack>
    );
  },
};
