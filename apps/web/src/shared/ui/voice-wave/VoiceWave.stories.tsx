import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { VoiceWave } from './VoiceWave';

/**
 * Звуковая дорожка надиктовки: столбцы во всю ширину, высота — громкость.
 * Волна течёт справа налево, новый отсчёт входит справа.
 */
const meta = {
  title: 'Компоненты/VoiceWave',
  component: VoiceWave,
  parameters: {
    docs: {
      description: {
        component:
          'Показывает, что микрофон слышит. Это не украшение: без обратной связи ' +
          'непонятно, идёт ли запись вообще, и человек говорит в тишину.\n\n' +
          'В тишине рисуется мягкая «дышащая» волна, а не мёртвая прямая — ' +
          'по прямой не отличить работающий микрофон от отвалившегося. ' +
          'При включённом «меньше движения» остаются статичные столбцы.',
      },
    },
  },
  args: { levels: buildLevels(), active: true },
  render: (args) => (
    <Card padding="md" style={{ width: 420 }}>
      <VoiceWave {...args} />
    </Card>
  ),
} satisfies Meta<typeof VoiceWave>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Правдоподобная речь: чередование громких и тихих участков. */
function buildLevels(): number[] {
  const shape = [0.2, 0.5, 0.8, 0.6, 0.9, 0.4, 0.3, 0.7, 0.95, 0.5, 0.2, 0.6, 0.85, 0.4];
  return Array.from({ length: 48 }, (_, index) => shape[index % shape.length] ?? 0.3);
}

export const Речь: Story = {};

export const Тишина: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Микрофон включён, но человек молчит — волна «дышит».',
      },
    },
  },
  args: { levels: Array.from({ length: 48 }, () => 0.02), active: true },
};

export const Выключен: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Запись не идёт: дорожка неподвижна.',
      },
    },
  },
  args: { levels: Array.from({ length: 48 }, () => 0.05), active: false },
};

export const Живая: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Поток отсчётов, как при настоящей надиктовке: окно сдвигается, ' +
          'новый отсчёт входит справа.',
      },
    },
  },
  render: function Render() {
    const [levels, setLevels] = useState(() => Array.from({ length: 48 }, () => 0.1));

    useEffect(() => {
      let frame = 0;
      const timer = window.setInterval(() => {
        frame += 1;
        // Синус с шумом — похоже на речь и не требует случайных чисел
        // на каждый кадр, поэтому картинка воспроизводима.
        const next = Math.abs(Math.sin(frame / 3)) * 0.7 + (frame % 5) * 0.05;
        setLevels((current) => [...current.slice(1), Math.min(1, next)]);
      }, 80);

      return () => window.clearInterval(timer);
    }, []);

    return (
      <Stack gap="var(--spacing-2xs)" style={{ width: 420 }}>
        <Card padding="md">
          <VoiceWave levels={levels} active />
        </Card>
        <Typography variant="caption" color="subtle">
          Переключите «Движение» в панели сверху — при «меньше движения» дорожка замирает.
        </Typography>
      </Stack>
    );
  },
};
