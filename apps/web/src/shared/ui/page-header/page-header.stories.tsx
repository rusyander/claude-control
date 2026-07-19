import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Stack } from '@shared/ui/stack';
import { PageHeader } from './page-header';

/** Шапка страницы: название, пояснение и главное действие раздела. */
const meta = {
  title: 'Компоненты/PageHeader',
  component: PageHeader,
  parameters: {
    docs: {
      description: {
        component:
          'Одинаковая шапка на всех страницах — по ней видно, где находишься. ' +
          'Подзаголовок объясняет раздел одной строкой: не «Настройки», ' +
          'а что именно здесь можно сделать.\n\n' +
          'Справа — главное действие раздела, и оно одно. Если действий больше, ' +
          'остальные уходят внутрь страницы.',
      },
    },
  },
  args: {
    title: 'Права доступа',
    subtitle: 'Что Claude делает сам, а что спрашивает',
  },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычная: Story = {};

export const БезПодзаголовка: Story = {
  args: { title: 'Справка', subtitle: undefined },
};

export const СДействием: Story = {
  args: {
    title: 'Скиллы',
    subtitle: 'Наборы инструкций, которые Claude подключает по описанию',
    actions: <Button leftIcon={<Icon name="plus" size={24} />}>Создать скилл</Button>,
  },
};

export const СНесколькимиДействиями: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Переключатель периода на аналитике — случай, когда справа не кнопка, ' +
          'а выбор режима просмотра.',
      },
    },
  },
  args: {
    title: 'Аналитика',
    subtitle: 'Расход токенов, сессии и работающие агенты — по локальным транскриптам',
    actions: (
      <Stack direction="row" gap="var(--spacing-2xs)">
        <Button size="sm" variant="secondary">
          7 дней
        </Button>
        <Button size="sm">30 дней</Button>
        <Button size="sm" variant="secondary">
          90 дней
        </Button>
        <Button size="sm" variant="secondary">
          За всё время
        </Button>
      </Stack>
    ),
  },
};

export const ДлинныйЗаголовок: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Проверка на переполнение: длинный текст переносится и не ломает кнопку.',
      },
    },
  },
  args: {
    title: 'Переменные окружения и секреты MCP-серверов',
    subtitle:
      'Настройки среды, токены доступа и всё, что Claude Code читает при старте сессии из файла настроек',
    actions: <Button leftIcon={<Icon name="plus" size={24} />}>Добавить переменную</Button>,
  },
};
