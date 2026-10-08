import type { Meta, StoryObj } from '@storybook/react-vite';
import { ReviewDecisionCard } from './ReviewDecisionCard';

const URL = 'https://gitlab.example.com/team/app/-/merge_requests/42';

/**
 * Решение по замечаниям ревью чужого MR (Т7). Панель довела ревью до списка и
 * остановилась: написать в чужой MR и переписать чужую ветку человек разрешает
 * сам.
 */
const meta = {
  title: 'Организмы/ReviewDecisionCard',
  component: ReviewDecisionCard,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Одно состояние на два места показа — хаб родителя и чат группы: источник ' +
          'один, связь чата.\n\n' +
          'Ответ ревью без блока итога — это НЕ «замечаний нет» (Д4): карточка так и ' +
          'говорит и даёт повторить итог в той же сессии. Правки есть, а ветка MR ' +
          'неизвестна (Д9) — вместо молчащей кнопки push стоит причина.',
      },
    },
  },
  args: {
    onDecide: () => undefined,
    onPush: () => undefined,
    onRetry: () => undefined,
    busy: false,
    item: {
      chatId: 'group-1',
      title: 'Ревью MR !42',
      review: {
        url: URL,
        branch: 'feature/login',
        onMrBranch: true,
        findings: ['Токен пишется в лог на уровне info.', 'Нет теста на истёкший refresh-токен.'],
      },
    },
  },
  render: (args) => (
    <div style={{ width: 520 }}>
      <ReviewDecisionCard {...args} />
    </div>
  ),
} satisfies Meta<typeof ReviewDecisionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ЖдётРешения: Story = {};

export const СоседиЖдутТоже: Story = { args: { others: 3 } };

/** Д4: блока итога нет — замечания неизвестны, повтор в той же сессии. */
export const ИтогаНет: Story = {
  args: {
    item: {
      chatId: 'group-1',
      title: 'Ревью MR !42',
      review: { url: URL, findings: [], missing: true },
    },
  },
};

export const ЧистоеРевью: Story = {
  args: {
    item: {
      chatId: 'group-1',
      review: { url: URL, findings: [], decision: 'none', decidedAt: '2026-09-23T10:00:00Z' },
    },
  },
};

export const ПравкиГотовы: Story = {
  args: {
    item: {
      chatId: 'group-1',
      title: 'Ревью MR !42',
      review: {
        url: URL,
        branch: 'feature/login',
        findings: ['Токен пишется в лог на уровне info.'],
        decision: 'both',
        decidedAt: '2026-09-23T10:00:00Z',
        postedAt: '2026-09-23T10:00:05Z',
        pushOffer: true,
      },
    },
  },
};

/** Д9: правки есть, а отправить их некуда — ветка MR неизвестна. */
export const ПушНекуда: Story = {
  args: {
    item: {
      chatId: 'group-1',
      review: {
        url: URL,
        findings: ['Токен пишется в лог на уровне info.'],
        decision: 'fix',
        decidedAt: '2026-09-23T10:00:00Z',
        pushBlocked: 'branch-unknown',
      },
    },
  },
};

export const КомментарийНеУшёл: Story = {
  args: {
    item: {
      chatId: 'group-1',
      review: {
        url: URL,
        findings: ['Токен пишется в лог на уровне info.'],
        decision: 'post',
        decidedAt: '2026-09-23T10:00:00Z',
        postError: 'GitLab ответил 403',
      },
    },
  },
};
