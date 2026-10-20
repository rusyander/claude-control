import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Mascot } from './mascot';
import { MASCOT_MOODS } from './mascot.constants';

/**
 * Дека — знак бренда, который ожил: тело цвета акцента, пунктирное кольцо —
 * шкала вокруг единственного глаза. Настроение задаёт мимику и движение.
 */
const meta = {
  title: 'Компоненты/Mascot',
  component: Mascot,
  parameters: {
    docs: {
      description: {
        component:
          'Настроение отражает состояние агентов: работают, ждут ответа, упали, закончили. ' +
          'Поза — CSS по `data-mood`, движение — разовые действия по `data-act` с паузами ' +
          '(моргнуть, оглядеться, подпрыгнуть); постоянно крутится только шкала в `working`. ' +
          'Каждая подвижная часть — свой слой, браузер двигает её без перерисовки. ' +
          '«Меньше движения» в настройках и системная настройка движение выключают.\n\n' +
          'Без `label` маскот — украшение и скрыт от чтения с экрана.',
      },
    },
  },
  args: { mood: 'idle', size: 96 },
} satisfies Meta<typeof Mascot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Покой: Story = {};

export const ВсеНастроения: Story = {
  render: (args) => (
    <Stack direction="row" gap="var(--spacing-lg)" wrap>
      {MASCOT_MOODS.map((mood) => (
        <Stack key={mood} gap="var(--spacing-xs)" align="center">
          <Mascot {...args} mood={mood} />
          <Typography variant="body-sm" color="subtle">
            {mood}
          </Typography>
        </Stack>
      ))}
    </Stack>
  ),
};

export const СмотритВбок: Story = {
  args: { look: { x: 1, y: -0.5 } },
};
