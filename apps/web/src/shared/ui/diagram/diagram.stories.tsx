import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { FlowDiagram } from './flow-diagram';
import { PriorityLadder } from './priority-ladder';

/**
 * Схемы для справки. Рисуются коробками и линиями на токенах темы: подписи
 * переводятся вместе с интерфейсом, тёмная тема получается сама, а к бандлу
 * не добавляется библиотека диаграмм.
 */
const meta = {
  title: 'Компоненты/Diagram',
  component: FlowDiagram,
  parameters: {
    docs: {
      description: {
        component:
          'Два вида схем закрывают почти всю справку. Поток отвечает на вопрос ' +
          '«как это доходит до Claude», лестница — на вопрос «кто кого ' +
          'перебивает».\n\nОттенок узла берётся из палитры приложения: свои ' +
          'цвета в схемах не заводятся.',
      },
    },
  },
  args: {
    ariaLabel: 'Как правило доходит до Claude',
    edgeLabels: ['сохранение', 'перезапуск'],
    nodes: [
      {
        id: 'form',
        label: 'Форма в панели',
        caption: 'заголовок и текст',
        tone: 'accent',
        icon: 'edit',
      },
      {
        id: 'file',
        label: 'CLAUDE.md',
        caption: 'раздел ## Заголовок',
        icon: 'file',
        isMono: true,
      },
      {
        id: 'claude',
        label: 'Старт сессии',
        caption: 'Claude читает файл',
        tone: 'info',
        icon: 'refresh',
      },
    ],
  },
} satisfies Meta<typeof FlowDiagram>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Поток: Story = {};

export const ПотокБезПодписейНаСтрелках: Story = {
  args: { edgeLabels: undefined },
};

export const ПотокИзДвухШагов: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Узлы делят ширину поровну независимо от длины подписи: схема читается как последовательность, а не как диаграмма величин.',
      },
    },
  },
  args: {
    edgeLabels: ['перенос'],
    nodes: [
      { id: 'off', label: 'Тумблер выключен', tone: 'warning', icon: 'close' },
      {
        id: 'moved',
        label: '## Отключённые правила',
        caption: 'конец файла',
        icon: 'file',
        isMono: true,
      },
    ],
  },
};

export const Лестница: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Порядок ступеней и есть смысл схемы: верхняя перебивает все нижние. Ширина убывает — сила правила видна раньше, чем прочитан текст.',
      },
    },
  },
  render: () => (
    <PriorityLadder
      ariaLabel="Приоритет правил доступа"
      topLabel="побеждает"
      bottomLabel="уступает"
      steps={[
        {
          id: 'deny',
          label: 'deny',
          caption: 'запрещено — перебивает всё остальное',
          tone: 'danger',
        },
        { id: 'ask', label: 'ask', caption: 'спросить перед выполнением', tone: 'warning' },
        { id: 'allow', label: 'allow', caption: 'выполнять без вопросов', tone: 'success' },
      ]}
    />
  ),
};

export const ОбеСхемыРядом: Story = {
  render: () => (
    <Stack gap="var(--spacing-xl)">
      <FlowDiagram
        ariaLabel="Как настройка доходит до Claude"
        edgeLabels={['запись с резервной копией', 'перезапуск']}
        nodes={[
          {
            id: 'panel',
            label: 'Панель',
            caption: 'формы и списки',
            tone: 'accent',
            icon: 'settings',
          },
          {
            id: 'files',
            label: 'Файлы в ~/.claude',
            caption: 'CLAUDE.md, settings.json',
            icon: 'folder',
          },
          {
            id: 'claude',
            label: 'Claude Code',
            caption: 'читает при старте',
            tone: 'info',
            icon: 'chat',
          },
        ]}
      />

      <PriorityLadder
        ariaLabel="Как выбирается каталог конфигурации"
        topLabel="побеждает"
        steps={[
          { id: 'manual', label: 'manual', caption: 'путь задан в настройках', tone: 'accent' },
          { id: 'env', label: 'env', caption: 'переменная CLAUDE_CONFIG_DIR', tone: 'info' },
          { id: 'home', label: 'home', caption: 'обычный ~/.claude' },
        ]}
      />
    </Stack>
  ),
};
