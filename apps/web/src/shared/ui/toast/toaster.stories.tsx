import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/lib/toast';
import { Toaster } from './toaster';

/**
 * Тосты — короткие уведомления об итоге действия: создано, удалено, ошибка.
 * Держатся три секунды, закрываются по крестику, стопка растёт вверх из
 * правого нижнего угла. Показываются откуда угодно через `toast.*(...)`.
 */
const meta = {
  title: 'Компоненты/Toaster',
  component: Toaster,
  parameters: {
    docs: {
      description: {
        component:
          'Контейнер уведомлений монтируется один раз в корне приложения. ' +
          'Кнопки ниже вызывают `toast.success/error/warning/info` — тот же API, ' +
          'что срабатывает по всему приложению на создание, удаление, ошибку запроса.',
      },
    },
  },
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Песочница: Story = {
  render: () => (
    <>
      <Stack gap="var(--spacing-sm)" style={{ maxWidth: 420 }}>
        <Typography variant="body-sm" color="muted">
          Нажми — тост появится в правом нижнем углу. Наведи на него, чтобы приостановить таймер;
          закрой крестиком.
        </Typography>
        <Stack direction="row" gap="var(--spacing-sm)" wrap>
          <Button variant="secondary" onClick={() => toast.success('Правило создано')}>
            Успех
          </Button>
          <Button variant="secondary" onClick={() => toast.error('Не удалось сохранить файл')}>
            Ошибка
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast.warning('Изменения применятся после пересборки')}
          >
            Предупреждение
          </Button>
          <Button variant="secondary" onClick={() => toast.info('Песочница запущена')}>
            Инфо
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              toast.success('Скопировано');
              toast.info('Хук выключен');
              toast.warning('Нужна пересборка');
              toast.error('Сервер недоступен');
            }}
          >
            Пачкой
          </Button>
        </Stack>
      </Stack>
      <Toaster />
    </>
  ),
};

/**
 * Настоящий случай, из-за которого тост переставал закрываться: вывод `git commit`
 * на сотню файлов. Карточка обязана остаться прежнего роста — три строки и
 * многоточие, — а весь текст открываться в окне по клику.
 */
const GIT_OUTPUT = [
  '[main 9267209] feat(mobile): адрес панели по умолчанию задаётся при сборке',
  ' 124 files changed, 4457 insertions(+), 396 deletions(-)',
  ' create mode 100644 inst-admin-api/internal/api/handler_guardrails_response_test.go',
  ' create mode 100644 inst-admin-api/internal/service/guardrail_cp_response_test.go',
  ' create mode 100644 inst-admin-api/internal/store/guardrails_response_test.go',
  ' create mode 100644 inst-admin-api/internal/store/teams_test.go',
  ' create mode 100644 mod-agentbox/src/agentbox/logging_safe.py',
  ' create mode 100644 mod-agentbox/tests/test_agent_from_definition.py',
  ' create mode 100644 mod-agentbox/tests/test_coordinator_worker.py',
  ' create mode 100644 mod-agentbox/tests/test_runs_coordinator_endpoint.py',
  ' create mode 100644 mod-kbbox/tests/test_embeddings.py',
  ' create mode 100644 mod-llmbox/tests/test_error_contract.py',
].join('\n');

export const ДлинныйТекст: Story = {
  render: () => (
    <>
      <Stack gap="var(--spacing-sm)" style={{ maxWidth: 520 }}>
        <Typography variant="body-sm" color="muted">
          Вывод команды на сотню файлов. Тост показывает начало, остальное — по клику.
        </Typography>
        <Stack direction="row" gap="var(--spacing-sm)" wrap>
          <Button variant="secondary" onClick={() => toast.success(GIT_OUTPUT)}>
            Длинный успех
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast.error(GIT_OUTPUT, { title: 'Коммит не прошёл' })}
          >
            Длинная ошибка с заголовком
          </Button>
        </Stack>
      </Stack>
      <Toaster />
    </>
  ),
};

export const СЗаголовком: Story = {
  render: () => (
    <>
      <Button
        variant="secondary"
        onClick={() =>
          toast.error('Проверьте, что сервер запущен на порту 5178.', {
            title: 'Сервер недоступен',
          })
        }
      >
        Показать тост с заголовком
      </Button>
      <Toaster />
    </>
  ),
};
