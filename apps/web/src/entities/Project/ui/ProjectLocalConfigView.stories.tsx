import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ProjectLocalConfig } from '@claude-control/contracts';
import { ProjectLocalConfigView } from './ProjectLocalConfigView';

/**
 * Собственный набор проекта из его `.claude`: скиллы, хуки и правила — только
 * чтение. Данные придуманы: витрина показывает форму, а не чей-то репозиторий.
 */
const SAMPLE: ProjectLocalConfig = {
  root: 'C:/work/sample-project/.claude',
  exists: true,
  skills: [
    {
      id: 'release-notes',
      name: 'release-notes',
      description: 'Собирает заметки к релизу из закрытых задач и коммитов ветки.',
      body: '',
      files: ['references/template.md', 'config/sections.json'],
      sizeBytes: 2048,
      modifiedAt: '2026-09-01T10:00:00.000Z',
      groupIds: [],
      isEnabled: true,
    },
    {
      id: 'legacy-migration',
      name: 'legacy-migration',
      description: 'Переносит модули со старого API — выключен до конца миграции.',
      body: '',
      files: [],
      sizeBytes: 1024,
      modifiedAt: '2026-08-20T10:00:00.000Z',
      groupIds: [],
      isEnabled: false,
    },
  ],
  hooks: [
    {
      id: 'PreToolUse:1a2b3c',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: 'node .claude/hooks/guard-shell.mjs',
      isEnabled: true,
      scriptPath: '.claude/hooks/guard-shell.mjs',
      scriptExists: true,
      description: 'Не даёт запускать деструктивные команды в рабочем дереве.',
      groupIds: [],
      source: 'settings',
    },
    {
      id: 'local:Stop:4d5e6f',
      event: 'Stop',
      command: 'node .claude/hooks/notify-me.mjs',
      isEnabled: true,
      scriptPath: '.claude/hooks/notify-me.mjs',
      scriptExists: false,
      groupIds: [],
      source: 'settings-local',
    },
  ],
  rules: [
    {
      path: 'frontend.md',
      title: 'Фронтенд',
      body: '# Фронтенд\n\n- Компоненты только функциональные.\n- Стили — CSS-модули.',
      paths: ['src/**/*.tsx', 'src/**/*.scss'],
      sizeBytes: 512,
      modifiedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      path: 'commits.md',
      title: 'Коммиты',
      body: '# Коммиты\n\nСообщение — что изменилось и зачем, без авторства.',
      paths: [],
      sizeBytes: 256,
      modifiedAt: '2026-08-15T10:00:00.000Z',
    },
  ],
};

const meta = {
  title: 'Организмы/ProjectLocalConfigView',
  component: ProjectLocalConfigView,
  parameters: {
    docs: {
      description: {
        component:
          'Три раздела со счётчиками: скиллы (`.claude/skills`), хуки ' +
          '(`.claude/settings.json` и `settings.local.json`) и правила (`.claude/rules`). ' +
          'Панель их только показывает — набор принадлежит гиту проекта и правится там.\n\n' +
          'Компактный режим стоит на карточке привязанной группы: строка счётчиков и ' +
          'кнопка, которая раскрывает те же три раздела.',
      },
    },
  },
  args: { config: SAMPLE, compact: false },
} satisfies Meta<typeof ProjectLocalConfigView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Полный вид — вкладка «Из проекта» на странице проектов. */
export const Default: Story = {};

/** Компактный вид — карточка группы: счётчики и кнопка раскрытия. */
export const Compact: Story = {
  args: { compact: true },
};

/** Каталога `.claude` в проекте нет — набор пуст, и это сказано прямо. */
export const NoDirectory: Story = {
  args: {
    config: {
      root: 'C:/work/bare-project/.claude',
      exists: false,
      skills: [],
      hooks: [],
      rules: [],
    },
  },
};

/** Каталог есть, но пуст: каждый раздел объясняет, чего в нём нет. */
export const EmptySections: Story = {
  args: { config: { ...SAMPLE, skills: [], hooks: [], rules: [] } },
};
