import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectCodeChanged } from './ProjectCodeChanged';

/**
 * Список файлов, которых касался агент в одном разговоре. Он открывается
 * первым: за ним в это окно и приходят.
 */
const meta = {
  title: 'Организмы/ProjectCodeChanged',
  component: ProjectCodeChanged,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'Плоский список, а не дерево: правки одного разговора обычно разбросаны по ' +
          'разным веткам проекта, и раскрывать до каждой по три уровня — работа ради ' +
          'работы.\n\n' +
          'Файл, которого уже нет на диске, показан отдельной пометкой и не ' +
          'открывается: агент его правил, а потом он был удалён или переименован.',
      },
    },
  },
  args: {
    isLoading: false,
    onSelect: () => undefined,
    changes: {
      files: [
        { path: 'apps/server/src/lib/config.ts', added: 9, removed: 2, missing: false },
        { path: 'apps/web/src/pages/Chat/ChatHeader.tsx', added: 14, removed: 0, missing: false },
        { path: 'packages/contracts/src/project-files.ts', added: 96, removed: 0, missing: false },
        { path: 'apps/web/src/features/Legacy/Old.tsx', added: 0, removed: 0, missing: true },
      ],
      skipped: 2,
    },
  },
  render: function Render(args) {
    const [selected, setSelected] = useState<string | undefined>(args.changes?.files[0]?.path);

    return (
      <div style={{ width: 320, border: '1px solid var(--color-border)' }}>
        <ProjectCodeChanged {...args} selected={selected} onSelect={setSelected} />
      </div>
    );
  },
} satisfies Meta<typeof ProjectCodeChanged>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Разговор ещё ничего не менял — обычное состояние нового чата. */
export const Empty: Story = {
  args: { changes: { files: [], skipped: 0 } },
};

export const Loading: Story = {
  args: { isLoading: true, changes: undefined },
};
