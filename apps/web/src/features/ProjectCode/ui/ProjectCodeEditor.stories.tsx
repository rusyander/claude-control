import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectCodeEditor } from './ProjectCodeEditor';

/**
 * Редактор файла проекта с диффом правок агента.
 *
 * Главное здесь видно только глазами, поэтому история и заведена: в редакторе
 * лежит ТЕКУЩИЙ текст файла — тот, что уйдёт на диск при сохранении, — а
 * прежний код показан серой вставкой, которой в файле уже нет.
 */
const BEFORE = `import { readFileSync } from 'node:fs';

export function readConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Config;
}

export interface Config {
  port: number;
}
`;

const AFTER = `import { readFileSync } from 'node:fs';

/** Конфиг панели: битый файл не должен ронять запуск. */
export function readConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as Config;
  } catch {
    return { port: 5178, host: '127.0.0.1' };
  }
}

export interface Config {
  port: number;
  host: string;
}
`;

const meta = {
  title: 'Организмы/ProjectCodeEditor',
  component: ProjectCodeEditor,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Зелёным — строки, которые агент добавил: они действительно лежат в файле ' +
          'и правятся как обычный текст.\n\n' +
          'Серым — то, что было раньше. Этого кода в файле уже нет, поэтому вставка ' +
          'не редактируется, в текст не попадает и никуда не сохраняется: она нужна ' +
          'только чтобы понять, что именно агент заменил.\n\n' +
          'База сравнения восстанавливается по правкам из транскрипта разговора, а не ' +
          'берётся из git: вопрос «что сделал агент ЗДЕСЬ» git ответить не может.',
      },
    },
  },
  args: {
    path: 'apps/server/src/lib/config.ts',
    content: AFTER,
    baseline: BEFORE,
    mtimeMs: 1,
    isEditable: true,
    showDiff: true,
    onChange: () => undefined,
    onSave: () => undefined,
  },
  render: (args) => (
    <div style={{ height: 460, border: '1px solid var(--color-border)' }}>
      <ProjectCodeEditor {...args} />
    </div>
  ),
} satisfies Meta<typeof ProjectCodeEditor>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Как это выглядит после работы агента: новое зелёным, прежнее серым. */
export const WithAgentEdits: Story = {};

/** Тумблер «Правки агента» снят — обычный редактор без подсветки различий. */
export const DiffOff: Story = {
  args: { showDiff: false },
};

/** Файл, которого агент не касался: сравнивать не с чем. */
export const NoEdits: Story = {
  args: { baseline: undefined, content: BEFORE },
};

/** Права ОС запрещают запись — правка недоступна, чтение работает. */
export const ReadOnly: Story = {
  args: { isEditable: false },
};
