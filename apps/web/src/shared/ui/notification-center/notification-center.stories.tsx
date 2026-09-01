import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/lib/toast';
import { Toaster } from '@shared/ui/toast';
import { NotificationCenter } from './notification-center';

/**
 * Журнал уведомлений: колокольчик со счётчиком непрочитанных и окно с последними
 * тостами. Нужен ровно потому, что тост живёт три секунды, — к пропущенному
 * сообщению возвращаются здесь.
 */
const meta = {
  title: 'Компоненты/NotificationCenter',
  component: NotificationCenter,
  parameters: {
    docs: {
      description: {
        component:
          'Живёт в боковой панели. Записи показывают те же три строки, что и тост; ' +
          'полный текст открывается кликом по записи — тем же окном, что и у тоста.',
      },
    },
  },
} satisfies Meta<typeof NotificationCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

const GIT_OUTPUT = [
  '[main 9267209] feat(mobile): адрес панели по умолчанию задаётся при сборке',
  ' 124 files changed, 4457 insertions(+), 396 deletions(-)',
  ' create mode 100644 inst-admin-api/internal/api/handler_guardrails_response_test.go',
  ' create mode 100644 inst-admin-api/internal/service/guardrail_cp_response_test.go',
  ' create mode 100644 inst-admin-api/internal/store/guardrails_response_test.go',
  ' create mode 100644 mod-agentbox/src/agentbox/logging_safe.py',
  ' create mode 100644 mod-agentbox/tests/test_coordinator_worker.py',
  ' create mode 100644 mod-kbbox/tests/test_embeddings.py',
  ' create mode 100644 mod-llmbox/tests/test_error_contract.py',
].join('\n');

export const Песочница: Story = {
  render: () => (
    <>
      <Stack gap="var(--spacing-md)" style={{ maxWidth: 320 }}>
        <Typography variant="body-sm" color="muted">
          Наполни журнал и открой колокольчик. Длинная запись обрезана тремя строками — весь текст
          открывается кликом по ней.
        </Typography>
        <Stack direction="row" gap="var(--spacing-sm)" wrap>
          <Button
            variant="secondary"
            onClick={() => {
              toast.success('Правило создано');
              toast.info('Хук выключен');
              toast.error(GIT_OUTPUT, { title: 'Коммит не прошёл' });
            }}
          >
            Наполнить журнал
          </Button>
        </Stack>
        <NotificationCenter />
      </Stack>
      <Toaster />
    </>
  ),
};
