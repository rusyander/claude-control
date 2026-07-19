import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { EmptyState } from './empty-state';

/**
 * Пустое состояние. Объясняет, почему здесь ничего нет и что с этим делать —
 * пустой экран без объяснения читается как поломка.
 */
const meta = {
  title: 'Компоненты/EmptyState',
  component: EmptyState,
  parameters: {
    docs: {
      description: {
        component:
          'Три разных пустоты требуют разного текста: ничего ещё не создано, ' +
          'ничего не нашлось по запросу, данных нет по существу.\n\n' +
          'Кнопка нужна не всегда — у пустого результата поиска действия нет, ' +
          'и предлагать «создать» там неуместно.',
      },
    },
  },
  args: {
    icon: 'groups',
    title: 'Пока нет ни одной группы',
    text: 'Группа объединяет правила, скиллы, хуки и серверы, чтобы включать их разом и задавать общие переменные. Удобно, когда набор настроек нужен под конкретную задачу.',
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычное: Story = {};

export const СДействием: Story = {
  args: {
    action: <Button leftIcon={<Icon name="plus" size={24} />}>Создать группу</Button>,
  },
};

export const БезТекста: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Когда объяснять нечего — короткая строка вместо абзаца.',
      },
    },
  },
  args: { icon: 'search', title: 'Ничего не найдено', text: undefined, action: undefined },
};

export const РазныеСлучаи: Story = {
  render: () => (
    <Stack gap="var(--spacing-2xl)">
      <EmptyState
        icon="chat"
        title="Чат с Claude Code"
        text="Полноценный разговор: можно приложить PDF, картинку или разметку, попросить собрать страницу или документ — и сразу посмотреть результат в превью."
        action={<Button variant="primary">Новый чат</Button>}
      />

      <EmptyState
        icon="search"
        title="Ничего не найдено"
        text="Попробуйте другое слово или очистите поиск."
      />

      <EmptyState
        icon="analytics"
        title="Данных за период нет"
        text="За выбранный отрезок обращений к модели не было. Выберите период подлиннее."
      />
    </Stack>
  ),
};
