import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChildStages } from './ChildStages';

/**
 * Хаб родителя: группы, звено каждой и ждёт ли она человека. Строка описывает
 * ГРУППУ, а не разговор: открывается последнее звено.
 */
const meta = {
  title: 'Организмы/ChildStages',
  component: ChildStages,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Группа, чьё звено спросило человека, — не «стоит»: фишка «ждёт вашего ответа» ' +
          '(Д16). «Идёт» — если идёт любое звено группы, а не только последнее (Д12).',
      },
    },
  },
  args: {
    onOpen: () => undefined,
    groups: [
      {
        chatId: 'work-a',
        title: 'Форма входа',
        branch: 'feature/login',
        stages: ['plan', 'work'],
        model: 'claude-sonnet-5',
        isRunning: true,
      },
      {
        chatId: 'work-b',
        title: 'Шапка',
        branch: 'feature/header',
        stages: ['work'],
        model: 'claude-sonnet-5',
        isRunning: false,
        waitingFor: 'question',
      },
      {
        chatId: 'fix-d',
        title: 'Тесты',
        branch: 'feature/tests',
        stages: ['work', 'review', 'fix'],
        model: 'claude-sonnet-5',
        isRunning: false,
      },
    ],
  },
  render: (args) => (
    <div style={{ width: 640 }}>
      <ChildStages {...args} />
    </div>
  ),
} satisfies Meta<typeof ChildStages>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ГруппыИОжидания: Story = {};

/** Дерево на паузе: группы остановлены и ждут «Продолжить всё». */
export const НаПаузе: Story = {
  args: {
    tree: {
      root: 'parent',
      running: 0,
      nodes: [],
      paused: { at: '2026-09-24T09:00:00Z', chats: 1, pending: 0 },
    },
    groups: [
      {
        chatId: 'work-a',
        title: 'Форма входа',
        branch: 'feature/login',
        stages: ['work'],
        model: 'claude-sonnet-5',
        isRunning: false,
        isPaused: true,
      },
    ],
  },
};
