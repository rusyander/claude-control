import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from './form-with-assistant';

/**
 * Раскладка «поля слева, помощник справа». На ней стоят все девять форм
 * приложения — поэтому окна форм и заданы одним размером `xl`.
 */
const meta = {
  title: 'Компоненты/FormWithAssistant',
  component: FormWithAssistant,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Две колонки: слева поля, справа помощник. Именно из-за этой раскладки ' +
          'все формы приложения открываются в окне размера `xl` — в узком окне ' +
          'колонки схлопываются и помощник перестаёт быть виден рядом с полями, ' +
          'а смысл в том, чтобы видеть их одновременно.\n\n' +
          '`fields` и `schema` передаются помощнику как контекст: что уже введено ' +
          'и что вообще можно заполнить. Заполняет он только описанные поля.\n\n' +
          '**Переписка требует поднятого сервера панели** — без него видна ' +
          'раскладка с пустым чатом.',
      },
    },
  },
  args: {
    kind: 'Правило доступа',
    fields: {},
    schema: {},
    onApply: () => undefined,
    children: null,
  },
} satisfies Meta<typeof FormWithAssistant>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ФормаПрава: Story = {
  render: function Render() {
    const [pattern, setPattern] = useState('Bash(git push:*)');
    const [decision, setDecision] = useState('ask');

    return (
      <div style={{ height: 520 }}>
        <FormWithAssistant
          kind="Правило доступа"
          fields={{ pattern, decision }}
          schema={{
            pattern: 'Шаблон: имя инструмента целиком (Bash, Read) или с уточнением',
            decision: 'Решение: allow, ask или deny',
          }}
          onApply={(applied) => {
            if (typeof applied.pattern === 'string') setPattern(applied.pattern);
            if (typeof applied.decision === 'string') setDecision(applied.decision);
          }}
          placeholder="Например: запрети пушить в main без подтверждения"
        >
          <Stack gap="var(--spacing-md)">
            <TextField
              label="Шаблон"
              value={pattern}
              onChange={setPattern}
              isMono
              hint="Точное имя инструмента или шаблон с уточнением в скобках."
            />
            <SelectField
              label="Решение"
              value={decision}
              onChange={setDecision}
              options={[
                { value: 'allow', label: 'allow — делать без вопросов' },
                { value: 'ask', label: 'ask — спрашивать подтверждение' },
                { value: 'deny', label: 'deny — запретить' },
              ]}
            />
          </Stack>
        </FormWithAssistant>
      </div>
    );
  },
};

export const ФормаСкилла: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Та же раскладка под другой раздел: полей больше, среди них длинное ' +
          'многострочное — колонка прокручивается независимо от помощника.',
      },
    },
  },
  render: function Render() {
    const [name, setName] = useState('a11y-audit');
    const [description, setDescription] = useState(
      'Use КОГДА пользователь просит проверить доступность интерфейса',
    );
    const [body, setBody] = useState('# Аудит доступности\n\nПорядок работы…');

    return (
      <div style={{ height: 520 }}>
        <FormWithAssistant
          kind="Скилл"
          fields={{ name, description, body }}
          schema={{
            name: 'Имя папки скилла: латиница через дефис',
            description: 'Описание, по которому Claude решает подключать скилл',
            body: 'Тело SKILL.md — сами инструкции',
          }}
          onApply={(applied) => {
            if (typeof applied.description === 'string') setDescription(applied.description);
          }}
          placeholder="Например: скилл для проверки контрастности и клавиатурной навигации"
        >
          <Stack gap="var(--spacing-md)">
            <TextField label="Имя" value={name} onChange={setName} isMono />
            <TextField
              label="Описание"
              value={description}
              onChange={setDescription}
              multiline
              rows={3}
              hint="Именно по нему Claude решает, подключать скилл или нет."
            />
            <TextField label="SKILL.md" value={body} onChange={setBody} multiline rows={8} isMono />
            <Typography variant="caption" color="subtle">
              Колонка с полями прокручивается сама по себе — помощник остаётся на месте.
            </Typography>
          </Stack>
        </FormWithAssistant>
      </div>
    );
  },
};
