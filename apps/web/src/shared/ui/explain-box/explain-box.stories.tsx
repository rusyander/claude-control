import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { ExplainBox } from './explain-box';

/**
 * Свёрнутая справка на странице: объясняет раздел тому, кто пришёл впервые,
 * и не мешает тому, кто уже разобрался.
 */
const meta = {
  title: 'Компоненты/ExplainBox',
  component: ExplainBox,
  parameters: {
    docs: {
      description: {
        component:
          'Приложение управляет вещами, которые не объяснить названием: хуки, ' +
          'права, MCP-серверы. Справка нужна прямо на странице — но каждый раз ' +
          'читать её незачем, поэтому блок свёрнут.\n\n' +
          'Текст отвечает на вопрос «что это и зачем», а не пересказывает ' +
          'интерфейс.',
      },
    },
  },
  args: {
    title: 'Как это работает',
    text:
      'Хук — это команда оболочки, привязанная к событию. PreToolUse срабатывает перед вызовом ' +
      'инструмента и может потребовать подтверждения, PostToolUse — после. Фильтр matcher ' +
      'ограничивает событие конкретными инструментами.',
  },
  argTypes: { defaultOpen: { control: 'boolean' } },
} satisfies Meta<typeof ExplainBox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Свёрнутый: Story = {};

export const Раскрытый: Story = {
  args: { defaultOpen: true },
};

export const РазныеРазделы: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Как справка выглядит на разных страницах — заголовок подбирается под раздел.',
      },
    },
  },
  render: () => (
    <Stack gap="var(--spacing-sm)" style={{ maxWidth: 720 }}>
      <ExplainBox
        title="Что это"
        text="CLAUDE.md читается при старте каждой сессии. Всё, что здесь написано, Claude учитывает как постоянные инструкции: язык общения, запреты, порядок работы."
      />
      <ExplainBox
        title="Зачем это"
        text="Группа объединяет правила, скиллы, хуки и серверы, чтобы включать их разом и задавать общие переменные. Удобно, когда набор настроек нужен под конкретную задачу."
      />
      <ExplainBox
        title="Где что хранится"
        text="Переменные окружения попадают в settings.json вашей конфигурации. Секреты MCP-серверов лежат отдельным файлом и в общий конфиг не пишутся."
      />
    </Stack>
  ),
};
