import { describe, expect, it } from 'vitest';
import type { GroupMembersView, PathEntry } from '@agentdeck/contracts';
import { describedStepTitle, previewSteps, projectOnlyLines, tileToggle } from './tile';

const step = (index: number, title: string): PathEntry => ({
  kind: 'skill-step',
  skillId: 'ticket-delivery',
  index,
  title,
});

const entries: PathEntry[] = [
  { kind: 'builtin', stage: 'triage' } as PathEntry,
  step(0, 'Read every comment'),
  step(1, 'Locate the defect'),
];

const view = (over: Partial<GroupMembersView>): GroupMembersView => ({
  groupId: 'g',
  members: [],
  steps: [],
  ...over,
});

describe('previewSteps: шаги скиллов на карточке', () => {
  it('описанный шаг — на языке интерфейса, а не английский заголовок раздела', () => {
    const described = view({
      steps: [
        {
          skillId: 'ticket-delivery',
          index: 0,
          title: { ru: 'Прочитать все комментарии', en: 'Read every comment' },
          summary: { ru: '…', en: '…' },
        },
      ],
      pending: ['step:ticket-delivery'],
    });
    const preview = previewSteps(entries, 'ru', 3, describedStepTitle(described, 'ru'));
    expect(preview.titles).toEqual(['Прочитать все комментарии']);
    // Неописанный шаг не пропадает из счёта: «и ещё 1».
    expect(preview).toMatchObject({ more: 1, waiting: 1 });
  });

  it('состав ещё не пришёл: в русском интерфейсе английского нет, карточка ждёт', () => {
    const preview = previewSteps(entries, 'ru', 3, describedStepTitle(undefined, 'ru'));
    expect(preview.titles).toEqual([]);
    expect(preview.waiting).toBe(2);
  });

  it('английский интерфейс и неудавшееся описание берут оригинал', () => {
    expect(previewSteps(entries, 'en', 3, describedStepTitle(undefined, 'en')).titles).toEqual([
      'Read every comment',
      'Locate the defect',
    ]);
    // Описание не в очереди и не пришло — описывать нечего, оригинал лучше пустоты.
    expect(previewSteps(entries, 'ru', 3, describedStepTitle(view({}), 'ru')).titles).toEqual([
      'Read every comment',
      'Locate the defect',
    ]);
  });
});

describe('участники только в проекте', () => {
  it('строка на проект, пропавшие без проекта не попадают', () => {
    const lines = projectOnlyLines(
      [
        { id: 'rule-incident-capture', foundIn: 'c:/work/shop' },
        { id: 'gone' },
        { id: 'figma-parity', foundIn: 'C:\\work\\shop' },
        { id: 'site-skill', foundIn: 'c:/work/site' },
      ],
      (project, names, count) => `${project}|${names}|${count}`,
    );
    expect(lines).toEqual(['shop|rule-incident-capture, figma-parity|2', 'site|site-skill|1']);
  });
});

describe('tileToggle: чей тумблер на карточке', () => {
  const claudeGroup = { isEnabled: true, enabledFor: { qwen: false, codex: true } };

  it('у Claude и пока список CLI не пришёл — каталоги Claude', () => {
    expect(tileToggle(claudeGroup, { id: 'claude', groupsModel: 'claude-files' })).toEqual({
      shown: true,
      checked: true,
    });
    expect(tileToggle(claudeGroup, undefined)).toEqual({ shown: true, checked: true });
  });

  it('CLI со слоем — положение этого CLI и его id для записи, не isEnabled Claude', () => {
    expect(tileToggle(claudeGroup, { id: 'qwen', groupsModel: 'run-layer' })).toEqual({
      shown: true,
      checked: false,
      provider: 'qwen',
    });
    expect(tileToggle(claudeGroup, { id: 'codex', groupsModel: 'run-layer' }).checked).toBe(true);
    expect(tileToggle({ isEnabled: false }, { id: 'qwen', groupsModel: 'run-layer' }).checked).toBe(
      false,
    );
  });

  it('CLI без слоя и копия для другой CLI — тумблера нет', () => {
    expect(tileToggle(claudeGroup, { id: 'goose', groupsModel: 'none' }).shown).toBe(false);
    const copy = { isEnabled: true, scope: { kind: 'global' as const, provider: 'codex' } };
    expect(tileToggle(copy, { id: 'codex', groupsModel: 'run-layer' }).shown).toBe(false);
  });

  it('проектная группа другого CLI — своим путём, как у сервера', () => {
    const own = {
      isEnabled: true,
      scope: { kind: 'project' as const, path: 'C:/p', provider: 'qwen' },
    };
    expect(tileToggle(own, { id: 'qwen', groupsModel: 'run-layer' })).toEqual({
      shown: true,
      checked: true,
    });
  });
});
