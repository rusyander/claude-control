import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SelectField } from './select-field';

/** Выбор одного значения из короткого списка. */
const meta = {
  title: 'Формы/SelectField',
  component: SelectField,
  parameters: {
    docs: {
      description: {
        component:
          'Для набора, который умещается в голове: событие хука, тип записи, вид ' +
          'сервера. Когда вариантов становится много и в них нужно искать — ' +
          'это уже не выпадающий список, а поиск.',
      },
    },
  },
  args: {
    label: 'Событие',
    value: 'PreToolUse',
    onChange: () => undefined,
    options: [
      { value: 'PreToolUse', label: 'PreToolUse' },
      { value: 'PostToolUse', label: 'PostToolUse' },
      { value: 'UserPromptSubmit', label: 'UserPromptSubmit' },
      { value: 'SessionStart', label: 'SessionStart' },
      { value: 'Stop', label: 'Stop' },
    ],
  },
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return <SelectField {...args} value={value} onChange={setValue} />;
  },
} satisfies Meta<typeof SelectField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Обычный: Story = {};

export const СПодсказкой: Story = {
  args: {
    hint: 'PreToolUse срабатывает до вызова инструмента и может его остановить.',
  },
};

export const КороткийСписок: Story = {
  args: {
    label: 'Тип сервера',
    value: 'stdio',
    options: [
      { value: 'stdio', label: 'stdio — локальный процесс' },
      { value: 'sse', label: 'SSE — поток по HTTP' },
      { value: 'http', label: 'HTTP — обычные запросы' },
    ],
  },
};
