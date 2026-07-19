import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ChatSummary } from '@claude-control/contracts';
import { mockChats } from '@shared/lib/mocks';
import { ChatList } from './ChatList';

/**
 * Список разговоров — целый блок, а не отдельный элемент: поиск, группировка
 * по дате, виртуализация и счётчик найденного работают вместе.
 */
const meta = {
  title: 'Организмы/ChatList',
  component: ChatList,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Сюда попадает вся история Claude Code — и работа из терминала, и из ' +
          'редактора, поэтому разговоров сотни и список виртуализирован.\n\n' +
          'Группы «Сегодня / Вчера / На этой неделе / Раньше» и относительное ' +
          'время появились не для красоты: раньше в строке стояла одна дата, ' +
          'у всех сегодняшних чатов одинаковая, и порядок списка не читался ' +
          'вовсе — хотя сортировка была верной.\n\n' +
          'Разговоры, заведённые в самой панели, помечены «Чат в панели»: у них ' +
          'файлы лежат в песочнице, а у остальных за папкой стоит настоящий проект.',
      },
    },
  },
  args: {
    chats: mockChats,
    isLoading: false,
    onSelect: () => undefined,
    onCreate: () => undefined,
  },
  render: function Render(args) {
    const [active, setActive] = useState<ChatSummary | undefined>(args.chats[0]);

    return (
      <div style={{ width: 300, height: 620, borderRight: '1px solid var(--color-border)' }}>
        <ChatList {...args} activeId={active?.id} onSelect={setActive} />
      </div>
    );
  },
} satisfies Meta<typeof ChatList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычный: Story = {};

export const Загрузка: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Пока история читается с диска — заглушки той же формы, что и строки.',
      },
    },
  },
  args: { chats: [], isLoading: true },
};

export const Пустой: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Разговоров ещё не было — остаётся кнопка «Новый чат».',
      },
    },
  },
  args: { chats: [] },
};

export const СотниРазговоров: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Настоящий объём: 400 записей. В DOM живёт десяток — прокрутите, ' +
          'строки создаются на лету. Заголовки групп идут строками того же ' +
          'списка и ниже обычных.',
      },
    },
  },
  args: {
    chats: Array.from({ length: 400 }, (_, index) => {
      const base = mockChats[index % mockChats.length]!;
      const shift = Math.floor(index / mockChats.length) * 36 * 60 * 60 * 1000;

      return {
        ...base,
        id: `${base.id}-${index}`,
        title: `${base.title} · ${index + 1}`,
        updatedAt: new Date(new Date(base.updatedAt).getTime() - shift).toISOString(),
      };
    }),
  },
};
