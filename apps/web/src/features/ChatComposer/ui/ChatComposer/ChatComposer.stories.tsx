import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChatComposer } from './ChatComposer';

/** Поле ввода чата: текст, надиктовка голосом и вложения. */
const meta = {
  title: 'Организмы/ChatComposer',
  component: ChatComposer,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Пока идёт ответ, отправка сменяется остановкой: прервать долгий ' +
          'разговор нужно уметь в любой момент, а не ждать его конца.\n\n' +
          'Enter отправляет, Shift+Enter переносит строку — как в мессенджерах. ' +
          'Поле растёт под текст до предела из стилей.\n\n' +
          'Файлы кладутся перетаскиванием или кнопкой. Кнопка отправки ' +
          'недоступна, пока в поле нет ничего кроме пробелов.',
      },
    },
  },
  args: {
    value: '',
    onChange: () => undefined,
    onSend: () => undefined,
    onStop: () => undefined,
    isRunning: false,
  },
  render: function Render(args) {
    const [value, setValue] = useState(args.value);
    return (
      <div style={{ maxWidth: 860 }}>
        <ChatComposer {...args} value={value} onChange={setValue} />
      </div>
    );
  },
} satisfies Meta<typeof ChatComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Пустой: Story = {};

export const СТекстом: Story = {
  args: { value: 'Собери страницу с графиком расхода по дням' },
};

export const ДлинныйЗапрос: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Поле выросло под текст и упёрлось в предел — дальше прокручивается.',
      },
    },
  },
  args: {
    value:
      'Проверь, как ведёт себя список чатов, если разговоров несколько сотен: ' +
      'нужно, чтобы поиск фильтровал на лету, группы по датам сохранялись, ' +
      'а прокрутка не подтормаживала. Заодно посмотри, что происходит при ' +
      'пустом результате поиска — там должно быть понятное объяснение, а не пустота.',
  },
};

export const ИдётОтвет: Story = {
  parameters: {
    docs: {
      description: {
        story: 'Отправка сменилась остановкой: разговор можно прервать в любой момент.',
      },
    },
  },
  args: { isRunning: true, value: '' },
};
