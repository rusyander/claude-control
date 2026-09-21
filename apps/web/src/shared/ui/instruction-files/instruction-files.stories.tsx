import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { InstructionFilesView } from '@agentdeck/contracts';
import { InstructionFilesCard } from './instruction-files';

/**
 * Раскладка файлов инструкций: что CLI читает, что лежит рядом непрочитанным.
 *
 * Витрина — единственное место, где эти состояния видно вживую: тесты панели
 * идут в node-окружении и ничего не отрисовывают. Поэтому здесь собраны все
 * четыре режима ключа `instructionFiles`, оба варианта «файла ещё нет» и каждая
 * заметка: именно они отличают пустой экран от экрана, который молчит по делу.
 */
const home = (view: Partial<InstructionFilesView> = {}): InstructionFilesView => ({
  mode: 'claude-md-or-agents-md',
  source: 'default',
  read: [{ fileName: 'CLAUDE.md', filePath: '/home/u/.claude/CLAUDE.md' }],
  ignored: [],
  choices: [],
  proposed: false,
  notes: [],
  ...view,
});

const meta = {
  title: 'Компоненты/InstructionFilesCard',
  component: InstructionFilesCard,
  parameters: {
    docs: {
      description: {
        component:
          'С 2.1.277 имя файла инструкций — не константа: опция `instructionFiles` плагина ' +
          '`agents-md` выбирает между `CLAUDE.md`, `AGENTS.md`, обоими сразу и «ни одним».\n\n' +
          'Карточка ПОКАЗЫВАЕТ раскладку и ничего не меняет: панель не переименовывает файл и ' +
          'не заводит второй. Причина — у CLI оставшийся рядом `CLAUDE.md` молча побеждает ' +
          '`AGENTS.md`, и решение об имени принадлежит человеку.\n\n' +
          'Имя предлагается ровно в одном случае — файла ещё нет на диске.',
      },
    },
  },
  args: { view: home() },
} satisfies Meta<typeof InstructionFilesCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ДомНаCLAUDEmd: Story = {};

export const ПроектНаAGENTSmd: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Своего `CLAUDE.md` в корне нет — CLI читает `AGENTS.md`. Без этой строки проект ' +
          'выглядел бы пустым: человек шёл бы искать файл не по тому имени.',
      },
    },
  },
  args: {
    view: home({
      read: [{ fileName: 'AGENTS.md', filePath: '/home/u/project/AGENTS.md' }],
    }),
  },
};

export const ВторойФайлРядомНеЧитается: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Оба файла лежат в корне, но режим читает только первый. Это тот самый случай, ' +
          'ради которого карточка и заведена: правка `AGENTS.md` здесь не доедет до CLI.',
      },
    },
  },
  args: {
    view: home({
      read: [{ fileName: 'CLAUDE.md', filePath: '/home/u/project/CLAUDE.md' }],
      ignored: [{ fileName: 'AGENTS.md', filePath: '/home/u/project/AGENTS.md' }],
      notes: [{ code: 'ignored-nearby', files: ['AGENTS.md'] }],
    }),
  },
};

export const ОбаЧитаются: Story = {
  args: {
    view: home({
      mode: 'claude-md-and-agents-md',
      source: 'instructionFiles',
      read: [
        { fileName: 'CLAUDE.md', filePath: '/home/u/project/CLAUDE.md' },
        { fileName: 'AGENTS.md', filePath: '/home/u/project/AGENTS.md' },
      ],
    }),
  },
};

export const СобственныеОтключены: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Режим `managed-only`: поле ниже правится, но в запрос не попадёт. Молчать об этом ' +
          'нельзя — иначе человек правит файл, который никто не читает.',
      },
    },
  },
  args: {
    view: home({
      mode: 'managed-only',
      source: 'instructionFiles',
      read: [],
      ignored: [{ fileName: 'CLAUDE.md', filePath: '/home/u/.claude/CLAUDE.md' }],
      notes: [{ code: 'managed-only' }],
    }),
  },
};

export const НастройкиНеПоняты: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Три заметки, каждая о своей беде настроек: устаревший ключ, нераспознанное ' +
          'значение и неразобранный файл. Режим при этом взят по умолчанию — и назван.',
      },
    },
  },
  args: {
    view: home({
      source: 'projectInstructions',
      notes: [
        { code: 'legacy-key' },
        { code: 'unrecognized', value: 'claude-md-only' },
        { code: 'unreadable-settings' },
      ],
    }),
  },
};

export const ВыборИмени: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Файла на диске ещё нет: имя — предложение панели, и его можно сменить до первого ' +
          'сохранения. Кнопки — настоящая радиогруппа: выбранная названа скринридеру через ' +
          '`aria-checked`, а не одной заливкой.',
      },
    },
  },
  render: function Render(args) {
    const [chosenName, setChosenName] = useState('AGENTS.md');

    return <InstructionFilesCard {...args} chosenName={chosenName} onChooseName={setChosenName} />;
  },
  args: {
    view: home({
      read: [],
      choices: ['CLAUDE.md', 'AGENTS.md'],
      proposed: true,
    }),
  },
};
