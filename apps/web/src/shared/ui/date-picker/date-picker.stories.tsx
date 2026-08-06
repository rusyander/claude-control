import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { DatePicker } from './date-picker';
import { todayIso } from './date-picker.lib';
import type { DateRangeValue } from './date-picker.types';

/** Выбор даты или диапазона календарём. */
const meta = {
  title: 'Компоненты/DatePicker',
  component: DatePicker,
  parameters: {
    docs: {
      description: {
        component:
          'Одна кнопка вместо пары полей `input[type=date]`. Нативное поле рисует ' +
          'браузер: оно игнорирует тему приложения, не умеет диапазон и на каждой ' +
          'ОС выглядит по-своему.\n\n' +
          '**Диапазон и одна дата — не два режима, а одно поведение.** Первый клик ' +
          'по календарю уже даёт законченный выбор из одних суток, и фильтр ' +
          'срабатывает сразу. Окно при этом не закрывается: второй клик растягивает ' +
          'выбор в диапазон. Закрывается оно, когда границы разошлись.',
      },
    },
  },
  // Компонент управляемый: истории подставляют собственное состояние через
  // render, а эти аргументы нужны типу — без них ни одна история не соберётся.
  args: {
    value: {},
    onChange: () => {},
    placeholder: 'Выберите даты',
    ariaLabel: 'Период',
    max: todayIso(),
  },
} satisfies Meta<typeof DatePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Общая обвязка: показывает, что именно ушло наружу через onChange. */
function Demo({ mode, initial }: { mode: 'single' | 'range'; initial?: DateRangeValue }) {
  const [value, setValue] = useState<DateRangeValue>(initial ?? {});

  return (
    <Stack gap="var(--spacing-sm)" align="start">
      <DatePicker
        mode={mode}
        value={value}
        onChange={setValue}
        max={todayIso()}
        placeholder={mode === 'range' ? 'Выберите даты' : 'Выберите дату'}
        ariaLabel="Период"
        isActive={Boolean(value.from)}
      />
      <Typography variant="caption" color="subtle">
        onChange: {value.from ? `${value.from} → ${value.to}` : '— (выбор сброшен)'}
      </Typography>
    </Stack>
  );
}

export const Диапазон: Story = {
  render: () => <Demo mode="range" />,
};

export const ОднаДата: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Режим `single` для случаев, где вторая дата не имеет смысла: календарь ' +
          'на один месяц, окно закрывается сразу после выбора.',
      },
    },
  },
  render: () => <Demo mode="single" />,
};

export const СВыбраннымДиапазоном: Story = {
  render: () => <Demo mode="range" initial={{ from: '2026-07-01', to: '2026-07-14' }} />,
};

export const ОдниСутки: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Одинаковые границы показываются одной датой, а не «31 июл. — 31 июл.»: ' +
          'повтор читается как ошибка ввода, хотя выбор именно такой и задумывался.',
      },
    },
  },
  render: () => <Demo mode="range" initial={{ from: '2026-07-31', to: '2026-07-31' }} />,
};
