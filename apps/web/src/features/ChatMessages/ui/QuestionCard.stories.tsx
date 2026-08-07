import type { Meta, StoryObj } from '@storybook/react-vite';
import { QuestionCard } from './QuestionCard';

/**
 * Вопрос агента с вариантами. Работа стоит, пока на него не ответят, поэтому в
 * ленте он не свёрнутая строка вызова инструмента, а карточка.
 */
const meta = {
  title: 'Организмы/QuestionCard',
  component: QuestionCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Вопросов в одном вызове бывает до четырёх, а ответ уходит ОДНИМ сообщением: ' +
          'каждое сообщение — это новый ход агента, и три подряд заставили бы его ' +
          'отвечать на первый вопрос, ничего не зная про остальные.\n\n' +
          'Поэтому карточка ведёт по одному: активен ровно один вопрос, отвеченные ' +
          'свёрнуты и их можно переспросить, следующие показаны, но погашены. ' +
          'Отправка одна на всю карточку, и промах по варианту исправим до неё, а ' +
          'не после.\n\n' +
          'Нажатие фиксируется мгновенно, не дожидаясь сервера: агент думает ' +
          'десятками секунд, и всё это время карточка обязана выглядеть отправленной, ' +
          'иначе человек решит, что клик не прошёл, и нажмёт ещё раз.',
      },
    },
  },
  args: {
    onPick: () => undefined,
    disabled: false,
    questions: [
      {
        header: 'Редактор',
        question: 'Чем строить окно кода?',
        options: [
          { label: 'CodeMirror 6', description: 'Легче, есть готовый дифф.' },
          { label: 'Monaco', description: 'Тяжелее, зато как в VS Code.' },
        ],
      },
      {
        header: 'База диффа',
        question: 'Что брать за «было»?',
        options: [
          { label: 'Правки агента в этом чате', description: 'Восстанавливаются из транскрипта.' },
          { label: 'Рабочее дерево против HEAD', description: 'Обычный git diff.' },
        ],
      },
      {
        header: 'Объём',
        question: 'Что входит в первую итерацию?',
        multiSelect: true,
        options: [
          { label: 'Дерево', description: 'Список файлов проекта.' },
          { label: 'Дифф', description: 'Правки агента поверх файла.' },
          { label: 'Правка файла', description: 'Запись на диск.' },
        ],
      },
    ],
  },
} satisfies Meta<typeof QuestionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const НесколькоВопросов: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Отвечайте по порядку: следующий вопрос погашен, пока не отвечен текущий. ' +
          'После последнего появляется кнопка отправки — до неё выбор ещё можно менять.',
      },
    },
  },
};

export const ОдинВопрос: Story = {
  args: { questions: meta.args.questions.slice(0, 1) },
  parameters: {
    docs: {
      description: {
        story:
          'Один вопрос с одиночным выбором отправляется сразу по щелчку: ' +
          'подтверждать нечего, а лишний шаг здесь только замедляет.',
      },
    },
  },
};

export const ТолькоЧтение: Story = {
  args: { onPick: undefined },
  parameters: {
    docs: {
      description: {
        story:
          'Вопрос из середины истории. Отвечать на него уже некуда, поэтому вариант — ' +
          'просто текст, а не кнопка, которая молча ничего не делает.',
      },
    },
  },
};

export const ПрогонИдёт: Story = {
  args: { disabled: true },
  parameters: {
    docs: {
      description: {
        story: 'Пока агент занят, отвечать нельзя: ход всё равно не прервать.',
      },
    },
  },
};
