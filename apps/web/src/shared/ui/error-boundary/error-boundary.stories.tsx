import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { ErrorBoundary } from './error-boundary';
import { CrashCard } from './crash-card';

/**
 * Граница ошибок и карточка сбоя. Без границы исключение в одном компоненте
 * снимало всё дерево: ни навигации, ни поля ввода — только пустота.
 */
const meta = {
  title: 'Компоненты/ErrorBoundary',
  component: ErrorBoundary,
  parameters: {
    docs: {
      description: {
        component:
          'Три меры одной границы: приложение целиком, раздел (роутер) и одно ' +
          'сообщение ленты. Карточка говорит, что упал код панели, а не данные, ' +
          'даёт повторить без перезагрузки и скопировать ошибку со стеком.',
      },
    },
  },
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error('Пробный сбой: компонент бросил исключение при отрисовке');
  return <Typography variant="body">Компонент отрисован, всё в порядке.</Typography>;
}

function Demo({ compact }: { compact: boolean }) {
  const [armed, setArmed] = useState(false);
  return (
    <Stack gap="var(--spacing-md)" align="start">
      <Button variant="danger" size="sm" onClick={() => setArmed(true)}>
        Сломать компонент
      </Button>
      <ErrorBoundary
        scope="витрина"
        fallback={(error, reset) => (
          <CrashCard
            compact={compact}
            error={error}
            onRetry={() => {
              setArmed(false);
              reset();
            }}
          />
        )}
      >
        <Bomb armed={armed} />
      </ErrorBoundary>
    </Stack>
  );
}

export const Раздел: Story = {
  args: { children: null, fallback: null },
  render: () => <Demo compact={false} />,
};

export const СообщениеЛенты: Story = {
  args: { children: null, fallback: null },
  render: () => <Demo compact />,
};
