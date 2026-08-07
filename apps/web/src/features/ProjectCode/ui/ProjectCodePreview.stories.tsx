import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ProjectFileContent } from '@claude-control/contracts';
import { ProjectCodePreview } from './ProjectCodePreview';

/** Файл, показанный как файл: рисунок рисунком, разметка — документом. */
function file(patch: Partial<ProjectFileContent>): ProjectFileContent {
  return {
    path: 'file',
    content: '',
    kind: 'none',
    added: 0,
    removed: 0,
    unmatched: 0,
    isBinary: false,
    sizeBytes: 0,
    mtimeMs: 1,
    tooBig: false,
    isReadOnly: false,
    ...patch,
  };
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">' +
  '<circle cx="60" cy="60" r="52" fill="#2f81f7" /><path d="M40 62l14 14 28-30" stroke="#fff" ' +
  'stroke-width="8" fill="none" /></svg>';

const MARKDOWN =
  '# Окно кода\n\nПоказ собирается из **набранного** текста, а не из файла на диске.\n\n' +
  '- картинки и PDF тянет браузер\n- SVG и разметку рисует панель\n\n```ts\nconst a = 1;\n```\n';

/**
 * Двоичное браузер тянет сам по адресу панели, текстовое рисуется прямо из
 * редактора — поэтому правка SVG или разметки видна ещё до сохранения.
 */
const meta = {
  title: 'Организмы/ProjectCodePreview',
  component: ProjectCodePreview,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'SVG идёт в тег `img` через data-адрес намеренно: внутри `img` браузер не ' +
          'выполняет ни скриптов, ни внешних загрузок, а файл из чужого репозитория — ' +
          'такой же недоверенный ввод, как текст модели.\n\n' +
          'Картинку и PDF показать в Storybook нечем: за их байтами нужен сервер ' +
          'панели, поэтому здесь только то, что рисуется из текста.',
      },
    },
  },
  args: { projectPath: 'C:/work/project', file: file({}), text: '' },
  render: (args) => (
    <div style={{ width: 640, height: 420, border: '1px solid var(--color-border)' }}>
      <ProjectCodePreview {...args} />
    </div>
  ),
} satisfies Meta<typeof ProjectCodePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Рисунок: Story = {
  args: { file: file({ path: 'icon.svg', preview: 'svg', content: SVG }), text: SVG },
};

export const Разметка: Story = {
  args: {
    file: file({ path: 'README.md', preview: 'markdown', content: MARKDOWN }),
    text: MARKDOWN,
  },
};

export const ПустойФайл: Story = {
  args: { file: file({ path: 'icon.svg', preview: 'svg' }), text: '' },
  parameters: {
    docs: {
      description: {
        story: 'Показывать нечего — так и написано: пустая рамка выглядела бы поломкой.',
      },
    },
  },
};
