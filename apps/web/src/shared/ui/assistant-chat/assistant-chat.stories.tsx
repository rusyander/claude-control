import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { AssistantChat } from './assistant-chat';

/**
 * Помощник при форме: описываешь задачу словами — он предлагает значения
 * полей. Стоит рядом с каждой формой приложения.
 */
const meta = {
  title: 'Компоненты/AssistantChat',
  component: AssistantChat,
  parameters: {
    docs: {
      description: {
        component:
          'Формы приложения заполняются не самыми очевидными вещами: шаблон права ' +
          'доступа, команда хука, описание скилла. Помощник переводит намерение ' +
          '(«запрети пушить в main») в конкретные значения полей.\n\n' +
          'Он ничего не сохраняет сам: предлагает, показывает список изменённых ' +
          'полей и ждёт, пока человек нажмёт «применить». Заполнять форму молча ' +
          'за пользователя — способ получить не то, что просили.\n\n' +
          '**Ответы приходят с локального сервера панели.** В витрине переписка ' +
          'работает, только если сервер поднят (`apps/server`); без него виден ' +
          'пустой чат с подсказкой — это тоже рабочее состояние.',
      },
    },
  },
  args: {
    kind: 'Правило доступа',
    fields: { pattern: '', decision: 'ask' },
    schema: {
      pattern: 'Шаблон: имя инструмента целиком (Bash, Read) или с уточнением — Bash(git push:*)',
      decision: 'Решение: allow — без вопросов, ask — спросить, deny — запретить',
    },
    onApply: () => undefined,
    placeholder: 'Например: запрети пушить в main без подтверждения',
  },
  render: (args) => (
    <div style={{ width: 460, height: 420 }}>
      <AssistantChat {...args} />
    </div>
  ),
} satisfies Meta<typeof AssistantChat>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Пустой: Story = {};

export const ДругойРаздел: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Подсказка и описание полей меняются под раздел — помощник у хуков ' +
          'и у скиллов спрашивает о разном.',
      },
    },
  },
  args: {
    kind: 'Хук',
    fields: { event: 'PreToolUse', matcher: '', command: '' },
    schema: {
      event: 'Событие Claude Code: PreToolUse, PostToolUse, UserPromptSubmit',
      matcher: 'Каких инструментов касается: Bash, Write|Edit',
      command: 'Команда оболочки, которая запустится на событии',
    },
    placeholder: 'Например: перед любой git-командой спрашивать подтверждение',
  },
};

export const СПрименениемВФорму: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Что происходит после «применить»: значения уезжают в форму. Здесь ' +
          'форма показана рядом, чтобы это было видно.',
      },
    },
  },
  render: function Render(args) {
    const [fields, setFields] = useState<Record<string, unknown>>({ pattern: '', decision: 'ask' });

    return (
      <Stack direction="row" gap="var(--spacing-md)" align="stretch">
        <div style={{ width: 420, height: 420 }}>
          <AssistantChat
            {...args}
            fields={fields}
            onApply={(applied) => setFields((current) => ({ ...current, ...applied }))}
          />
        </div>

        <Card padding="md" style={{ width: 280 }}>
          <Stack gap="var(--spacing-xs)">
            <Typography variant="body-sm" weight="medium">
              Состояние формы
            </Typography>
            <Typography variant="mono" color="muted" as="pre">
              {JSON.stringify(fields, null, 2)}
            </Typography>
          </Stack>
        </Card>
      </Stack>
    );
  },
};
