import type { Meta, StoryObj } from '@storybook/react-vite';
import { mockMessages, mockStream } from '@shared/lib/mocks';
import { ChatMessages } from './ChatMessages';

/**
 * Лента переписки: история из транскрипта плюс ответ, который набирается
 * прямо сейчас. Размышления и вызовы инструментов свёрнуты.
 */
const meta = {
  title: 'Организмы/ChatMessages',
  component: ChatMessages,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Ответ живёт в двух местах: пока печатается — в потоке, после записи ' +
          'в транскрипт — в истории. Лента показывает и то и другое, а когда ' +
          'история догоняет поток, поток гасится — иначе ответ двоился бы.\n\n' +
          'Размышления и вызовы инструментов свёрнуты: их бывает десятки на один ' +
          'ответ, и развёрнутыми они топят сам ответ.\n\n' +
          'Прокрутка следует за ответом, только пока пользователь внизу. Стоит ' +
          'отлистать вверх, чтобы перечитать, — лента отпускает: раньше она ' +
          'тянула вниз на каждом слове, и читать во время ответа было нельзя.',
      },
    },
  },
  args: {
    messages: mockMessages,
    stream: mockStream.idle,
    isLoading: false,
    onEdit: () => undefined,
  },
  render: (args) => (
    <div style={{ height: 560, display: 'flex', flexDirection: 'column' }}>
      <ChatMessages {...args} />
    </div>
  ),
} satisfies Meta<typeof ChatMessages>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Переписка: Story = {};

export const ОтветНабирается: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Текст идёт посимвольно, в конце — мигающая каретка.',
      },
    },
  },
  args: { stream: mockStream.typing },
};

export const РаботаетСИнструментами: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Текста ещё нет — идут размышления и вызовы инструментов. До первого ' +
          'слова проходят секунды, и без этого блока разговор выглядел бы зависшим.',
      },
    },
  },
  args: { stream: mockStream.working },
};

export const Ошибка: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Ответ не получен. Своя реплика остаётся на месте — её не стирает, ' +
          'иначе непонятно, на что именно пришла ошибка.',
      },
    },
  },
  args: { stream: mockStream.failed },
};

export const ОчередьДописанного: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Агент занят, а сказать ему уже есть что. Дописанное стоит в ленте ' +
          'пузырём-призраком — пунктиром и приглушённо: принято, но агент этого ' +
          'ещё не видел. Уйдёт само, как только закончится текущий ход; передумал ' +
          '— крестик снимает из очереди вместе с пузырём.',
      },
    },
  },
  args: {
    stream: mockStream.typing,
    queued: [
      { id: 'q-1', prompt: 'Заодно проверь, что порт не занят' },
      { id: 'q-2', prompt: 'И покажи, чем кончился прогон тестов' },
    ],
    onCancelQueued: () => undefined,
  },
};

export const СвязьПотеряна: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Переподключения кончились, а поток так и не ожил. Агент при этом мог ' +
          'спокойно доработать: он живёт на сервере, а не во вкладке, — поэтому ' +
          'лента не обещает «сейчас починим», а зовёт перечитать переписку, где ' +
          'его ответ и лежит. Молчать нельзя: от «агент думает» это неотличимо.',
      },
    },
  },
  args: {
    stream: { ...mockStream.idle, dropped: true },
    onRefresh: () => undefined,
  },
};

export const Загрузка: Story = {
  args: { messages: [], isLoading: true },
};

export const ДлиннаяИстория: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Лента открывается у последнего сообщения, а не сверху.',
      },
    },
  },
  args: {
    messages: Array.from({ length: 40 }, (_, index) => {
      const base = mockMessages[index % mockMessages.length]!;
      return { ...base, id: `${base.id}-${index}` };
    }),
  },
};
