import type { Meta, StoryObj } from '@storybook/react-vite';
import { TaskSplitCard } from './TaskSplitCard';

/**
 * Предложение разделить задачи по чатам. Карточка — решение человека: состав
 * групп и две равноправные кнопки.
 */
const meta = {
  title: 'Организмы/TaskSplitCard',
  component: TaskSplitCard,
  parameters: { layout: 'centered' },
  args: {
    proposal: {
      shared: 'Фронтенд проекта, ветки от main. Каждая группа — один MR.',
      groups: [
        {
          title: 'APP-101, APP-102: форма входа',
          branch: 'fix/APP-101-login',
          tasks: ['APP-101 — поле пароля теряет фокус', 'APP-102 — ошибка входа без текста'],
        },
        {
          title: 'APP-110: шапка',
          branch: 'fix/APP-110-header',
          tasks: ['APP-110 — меню не закрывается по Esc'],
        },
      ],
    },
    onSplit: () => undefined,
    onKeepHere: () => undefined,
  },
  render: (args) => (
    <div style={{ width: 640 }}>
      <TaskSplitCard {...args} />
    </div>
  ),
} satisfies Meta<typeof TaskSplitCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Предложение: Story = {};

/**
 * Выгрузка больше потолков: лишние группы и задачи отброшены, и карточка
 * говорит об этом вслух, а не теряет хвост молча.
 */
export const СверхПотолка: Story = {
  args: {
    proposal: {
      ...meta.args.proposal,
      dropped: { groups: 4, tasks: 7 },
    },
  },
};
