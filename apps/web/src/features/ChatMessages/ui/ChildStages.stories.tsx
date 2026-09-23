import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChildStages } from './ChildStages';

/**
 * Хаб родителя: группы разделения, звено каждой и чего она ждёт. Строка
 * описывает ГРУППУ, а не разговор: открывается последнее звено.
 */
const meta = {
  title: 'Организмы/ChildStages',
  component: ChildStages,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Группа, чей ход кончился ожиданием, — не «стоит»: фишка говорит, чего она ждёт ' +
          '(вопроса человеку, решения по ревью, фона, повтора — Д3, Д16), что сделано (Д5) и хвост ' +
          'последнего ответа (Д16). «Идёт» — если идёт ' +
          'любое звено группы, а не только последнее (Д12).',
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
        tail: 'Шапку делать липкой на мобильном тоже или только на десктопе?',
      },
      {
        chatId: 'review-c',
        title: 'Ревью MR !42',
        branch: 'feature/mr',
        stages: ['review'],
        model: 'claude-opus-5-5',
        isRunning: false,
        waitingFor: 'decision',
        result: { kind: 'reviewed' },
      },
      {
        chatId: 'fix-d',
        title: 'Тесты',
        branch: 'feature/tests',
        stages: ['work', 'review', 'fix'],
        model: 'claude-sonnet-5',
        isRunning: false,
        waitingFor: 'background',
        result: { kind: 'changed', commits: 2 },
      },
      {
        chatId: '',
        title: 'Документация',
        branch: 'feature/docs',
        stages: [],
        isRunning: false,
        pending: 'waiting',
        groupIndex: 4,
        waitsFor: ['Форма входа'],
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

/**
 * Закрытые группы: сдавшаяся после повторов панели (Д10) и кончившие работу.
 * Закрытой группе предлагают убрать копию (Д19); убранная говорит, что стало с
 * веткой. Сама панель не удаляет ничего.
 */
export const ЗакрытыеГруппыИКопии: Story = {
  args: {
    tree: {
      root: 'parent',
      running: 0,
      nodes: [],
      split: { parentChatId: 'parent', order: [0, 1, 2], groups: [] },
    },
    groups: [
      {
        chatId: 'work-a',
        title: 'Форма входа',
        branch: 'feature/login',
        stages: ['work'],
        model: 'claude-sonnet-5',
        isRunning: false,
        error: 'API Error: fetch failed',
        retries: 3,
        copy: { index: 0 },
      },
      {
        chatId: 'work-b',
        title: 'Шапка',
        branch: 'feature/header',
        stages: ['work', 'review'],
        model: 'claude-sonnet-5',
        isRunning: false,
        result: { kind: 'changed', commits: 2 },
        copy: { index: 1 },
      },
      {
        chatId: 'work-c',
        title: 'Подвал',
        branch: 'feature/footer',
        stages: ['work'],
        model: 'claude-sonnet-5',
        isRunning: false,
        result: { kind: 'unchanged' },
        copy: { index: 2, cleaned: 'deleted' },
      },
    ],
  },
};

/**
 * Доставка до MR и очередь: сдавшая группа ведёт ссылкой прямо в свой MR, а
 * группы сверх настройки «Групп разом» стоят «в очереди» и стартуют сами.
 */
export const ДоставкаИОчередь: Story = {
  args: {
    tree: {
      root: 'parent',
      running: 1,
      nodes: [],
      split: {
        parentChatId: 'parent',
        order: [0, 1, 2, 3],
        groups: [],
        triage: { at: '2026-09-24T09:00:00Z', received: true, repairs: [], conflicts: [] },
      },
    },
    groups: [
      {
        chatId: 'work-a',
        title: 'APP-101, APP-102: форма входа',
        branch: 'fix/APP-101-login',
        stages: ['work'],
        model: 'claude-opus-5-5',
        isRunning: false,
        result: { kind: 'changed', commits: 3 },
        mr: 'https://git.example.com/team/app/-/merge_requests/815',
      },
      {
        chatId: 'work-b',
        title: 'APP-110: шапка',
        branch: 'fix/APP-110-header',
        stages: ['work'],
        model: 'claude-opus-5-5',
        isRunning: true,
      },
      {
        chatId: '',
        title: 'APP-120, APP-121: подвал',
        branch: 'fix/APP-120-footer',
        stages: [],
        isRunning: false,
        pending: 'queued',
        groupIndex: 2,
      },
      {
        chatId: '',
        title: 'APP-130: документация',
        branch: 'fix/APP-130-docs',
        stages: [],
        isRunning: false,
        pending: 'queued',
        groupIndex: 3,
      },
    ],
  },
};
