import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { VirtualList } from './virtual-list';

/**
 * Список с виртуализацией: в DOM живут только видимые строки. Нужен там,
 * где записей сотни — история чатов, каталог плагинов, список прав.
 */
const meta = {
  title: 'Данные/VirtualList',
  component: VirtualList,
  parameters: {
    docs: {
      description: {
        component:
          'Виртуализация включается по порогу, а не всегда: она ломает поиск ' +
          'по странице (Ctrl+F) и выделение текста, а на коротком списке ' +
          'выигрыша не даёт. До `threshold` строк список обычный.\n\n' +
          '`rowHeight` принимает и функцию — для списков, где строки разной ' +
          'высоты. Так сделаны заголовки групп «Сегодня / Вчера» в истории чатов.',
      },
    },
  },
  args: {
    items: [],
    rowHeight: 56,
    height: 360,
    getKey: (_item: unknown, index: number) => String(index),
    renderRow: () => null,
  },
} satisfies Meta<typeof VirtualList>;

export default meta;
type Story = StoryObj<typeof meta>;

const chats = Array.from({ length: 400 }, (_, index) => ({
  id: `chat-${index}`,
  title: `Разговор № ${index + 1}`,
  project: index % 3 === 0 ? 'claude-control' : 'gorgona',
}));

export const ДлинныйСписок: Story = {
  parameters: {
    docs: {
      description: {
        story: '400 записей, в DOM — десяток. Прокрутите: строки создаются на лету.',
      },
    },
  },
  render: () => (
    <Card padding="none" style={{ width: 360, overflow: 'hidden' }}>
      <VirtualList
        items={chats}
        rowHeight={56}
        height={360}
        getKey={(chat) => chat.id}
        renderRow={(chat) => (
          <Stack
            gap="var(--spacing-3xs)"
            style={{ padding: 'var(--spacing-xs) var(--spacing-sm)' }}
          >
            <Typography variant="body-sm" weight="medium" as="span">
              {chat.title}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {chat.project}
            </Typography>
          </Stack>
        )}
      />
    </Card>
  ),
};

export const КороткийСписок: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Меньше порога — виртуализация не включается, и список ведёт себя как ' +
          'обычный: работает поиск по странице и выделение текста.',
      },
    },
  },
  render: () => (
    <Card padding="none" style={{ width: 360, overflow: 'hidden' }}>
      <VirtualList
        items={chats.slice(0, 6)}
        rowHeight={56}
        height={360}
        getKey={(chat) => chat.id}
        renderRow={(chat) => (
          <Typography variant="body-sm" as="div" style={{ padding: 'var(--spacing-sm)' }}>
            {chat.title}
          </Typography>
        )}
      />
    </Card>
  ),
};

type Row = { kind: 'header'; label: string } | { kind: 'item'; label: string };

const grouped: Row[] = [
  { kind: 'header', label: 'СЕГОДНЯ' },
  ...chats.slice(0, 40).map((chat): Row => ({ kind: 'item', label: chat.title })),
  { kind: 'header', label: 'ВЧЕРА' },
  ...chats.slice(40, 90).map((chat): Row => ({ kind: 'item', label: chat.title })),
];

export const РазнаяВысотаСтрок: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Заголовки групп идут строками того же списка и ниже обычных. ' +
          'Так устроена история чатов: иначе виртуализация и разбивка по датам ' +
          'мешали бы друг другу.',
      },
    },
  },
  render: () => (
    <Card padding="none" style={{ width: 360, overflow: 'hidden' }}>
      <VirtualList
        items={grouped}
        rowHeight={(row) => (row.kind === 'header' ? 32 : 44)}
        height={360}
        getKey={(row, index) => `${row.kind}-${index}`}
        renderRow={(row) =>
          row.kind === 'header' ? (
            <Typography
              variant="caption"
              color="subtle"
              as="div"
              style={{ padding: '0 var(--spacing-sm)', lineHeight: '32px' }}
            >
              {row.label}
            </Typography>
          ) : (
            <Typography
              variant="body-sm"
              as="div"
              style={{ padding: 'var(--spacing-xs) var(--spacing-sm)' }}
            >
              {row.label}
            </Typography>
          )
        }
      />
    </Card>
  ),
};
