import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectCodeChanged } from './ProjectCodeChanged';

/**
 * Что в проекте изменено: правки агента за разговор и рабочее дерево git. Этот
 * список открывается первым: за ним в окно кода и приходят.
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
          'Два источника разделены заголовками: сверху — что тронул агент в этом ' +
          'разговоре (со счётчиками строк), ниже — остальное, что git видит в рабочем ' +
          'дереве (буквой состояния). Файл, которого уже нет на диске, показан ' +
          'пометкой и не открывается.',
      },
    },
  },
  args: {
    isLoading: false,
    onSelect: () => undefined,
    skipped: 2,
    git: {
      isRepo: true,
      branch: 'feat/cascade',
      detached: false,
      unborn: false,
      branches: ['main', 'feat/cascade'],
      dirtyCount: 6,
      changedFiles: [],
      remoteBranches: [],
      insertions: 119,
      deletions: 2,
    },
    rows: [
      { path: 'apps/server/src/lib/config.ts', source: 'agent', added: 9, removed: 2 },
      {
        path: 'apps/web/src/pages/Chat/ChatHeader.tsx',
        source: 'agent',
        added: 14,
        removed: 0,
        status: 'modified',
        staged: false,
      },
      { path: 'packages/contracts/src/project-files.ts', source: 'agent', added: 96, removed: 0 },
      { path: 'apps/web/src/features/Legacy/Old.tsx', source: 'agent', missing: true },
      { path: 'TASKS.md', source: 'git', status: 'modified', staged: false },
      { path: 'docs/NEW.md', source: 'git', status: 'untracked', staged: false },
    ],
  },
  render: function Render(args) {
    const [selected, setSelected] = useState<string | undefined>(args.rows[0]?.path);

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

/** Разговор ещё ничего не менял, но рабочее дерево уже не как в HEAD. */
export const GitOnly: Story = {
  args: {
    skipped: 0,
    rows: [
      { path: 'TASKS.md', source: 'git', status: 'modified', staged: false },
      {
        path: 'apps/web/src/shared/ui/badge/Badge.tsx',
        source: 'git',
        status: 'added',
        staged: true,
      },
      { path: 'docs/NEW.md', source: 'git', status: 'untracked', staged: false },
    ],
  },
};

/** Ни агент, ни git изменений не видят — чистое дерево на свежем чате. */
export const Empty: Story = {
  args: { rows: [], skipped: 0 },
};

export const Loading: Story = {
  args: { isLoading: true, rows: [] },
};
