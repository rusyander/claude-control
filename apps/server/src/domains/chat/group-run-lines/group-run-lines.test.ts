import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { reviewLinkPrompt } from '@agentdeck/contracts/model-cascade';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { projectKey, updateGroupSources } from '../../../lib/app-store/group-sources.ts';
import { createChat } from '../../provider-chat/store/store.ts';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import {
  FOREIGN_CHILD_NO_TOOL_LOOP_PROMPT,
  FOREIGN_CHILD_PROMPT,
  FOREIGN_GROUP_ECONOMY_PROMPT,
} from '../initiative/initiative.ts';
import { WORK_HABITS_SHARED_NOTE } from '../group-profile/group-profile.ts';
import { TASK_NOTEBOOK } from '../task-notebook/task-notebook.ts';
import { TASK_TICKETS } from '../task-tickets/task-tickets.ts';
import {
  chatKnobsLine,
  childStageExtra,
  foreignChildExtra,
  runPathSteps,
} from './group-run-lines.ts';

/**
 * F-107, соседи остатка (V-fix-D): закрепление, сделанное, пока его сторона
 * пары действовала, переживает смену стороны. Включение на старте его уже
 * сверяет (`activateEffectiveGroup`), а шаги «Пути» и строка скиллов группы
 * читали закрепление как есть — прогон шёл по шагам неактивной половины.
 */

function step(id: string, anchor: PathStep['anchor'] = 'work'): PathStep {
  return {
    id,
    anchor,
    order: 0,
    kind: 'prompt',
    title: { ru: `Шаг ${id}`, en: `Step ${id}` },
    prompt: { ru: `Сделай ${id}`, en: `Do ${id}` },
    source: 'ru',
    createdAt: '2026-09-28T10:00:00.000Z',
  };
}

const group = (patch: Partial<Group>): Group =>
  ({
    id: 'g',
    name: 'Набор',
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    projectPaths: [],
    isEnabled: false,
    order: 0,
    when: '',
    ...patch,
  }) as Group;

describe('строки группы прогона сверяют закрепление с парой проекта', () => {
  let dir: string;
  let appData: string;
  let store: AppStore;

  /** Пара: проектная и её глобальная копия, у каждой свои шаги. */
  const savePair = (flow?: Group['flow']): void => {
    const scope = { kind: 'project', path: dir, provider: 'claude' } as const;
    store.saveGroup(
      group({
        id: 'mine',
        name: 'Проектная',
        scope,
        order: 1,
        ...(flow ? { flow } : {}),
        path: { steps: [step('project-side', 'review')] },
      }),
    );
    store.saveGroup(
      group({
        id: 'mine-copy',
        name: 'Глобальная копия',
        origin: { groupId: 'mine', scope, hash: 'h' },
        order: 2,
        ...(flow ? { flow } : {}),
        path: { steps: [step('global-side', 'review')] },
      } as Partial<Group>),
    );
  };
  const chooseGlobal = (): void =>
    updateGroupSources(appData, (state) => {
      state.choices[projectKey(dir)] = 'global:mine-copy';
    });

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-run-lines-')));
    appData = join(dir, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    // Закреплено, пока действовала глобальная сторона; сейчас выбора нет —
    // действует проектная.
    store.setChatGroupSettings('pinned', { groupChoice: 'global:mine-copy' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('шаги «Пути» после стадии — действующей стороны, не закреплённой', () => {
    savePair();
    const ids = () => runPathSteps(store, appData, ['pinned'], 'review', dir).map((one) => one.id);
    expect(ids()).toEqual(['project-side']);
    chooseGlobal();
    expect(ids()).toEqual(['global-side']);
  });

  it('строка сценария Claude-прогона — действующей стороны', () => {
    savePair('scenario');
    const line = () => chatKnobsLine(store, appData, ['pinned'], dir) ?? '';
    expect(line()).toContain('Do project-side');
    expect(line()).not.toContain('global-side');
    chooseGlobal();
    expect(line()).toContain('Do global-side');
  });

  it('звено чужого CLI сверяет по своей рабочей папке', () => {
    savePair('scenario');
    const created = createChat(appData, 'codex', { title: 'звено', workdir: dir });
    expect(created).toBeDefined();
    const key = `codex:${created!.id}`;
    store.setChatLink(key, { parentChatId: 'pinned', createdAt: '2026-09-28T10:00:00.000Z' });
    const extra = () => foreignChildExtra(store, appData, key) ?? '';
    expect(extra()).toContain('Do project-side');
    expect(extra()).not.toContain('global-side');
    chooseGlobal();
    expect(extra()).toContain('Do global-side');
  });

  it('без рабочей папки закрепление остаётся как есть', () => {
    savePair();
    expect(
      runPathSteps(store, appData, ['pinned'], 'review', undefined).map((one) => one.id),
    ).toEqual(['global-side']);
  });
});

describe('правила ревью, переживающие сжатие контекста (T17, T4)', () => {
  it('ревью несёт формат карточки, схему следа требований и правило про ASK; работа — нет', () => {
    const review = childStageExtra('review', undefined);
    expect(review).toContain('finding-card format');
    expect(review).toContain('re-read the finding-card format');
    expect(review).toContain('"id":"owner-1"');
    expect(review).toContain('"ASK: N rounds > 6"');
    expect(review).toContain('never fewer diff lines per agent');
    expect(childStageExtra('work', undefined)).not.toContain('finding-card');
    expect(childStageExtra('fix', undefined)).toBe('');
  });

  it('дописка не зависит от задания: одна и та же строка у каждого, кто её строит', () => {
    expect(childStageExtra('review', 'числа группы')).toBe(
      `${childStageExtra('review', undefined)} числа группы`,
    );
    expect(childStageExtra('review', undefined)).toBe(childStageExtra('review', undefined));
  });
});

describe('ASK планировщика ревью в группе без человека (T4)', () => {
  it('задание ревью по ссылке называет решение заранее и бюджет спавнов от плана', () => {
    const prompt = reviewLinkPrompt({ url: 'https://tracker.example.com/x/-/merge_requests/1' });
    expect(prompt).toContain('Nobody answers questions in this group');
    expect(prompt).toContain('MORE agents per round');
    expect(prompt).toContain('do not tune --chunk or --per-round');
    expect(prompt).toContain('the agents of every round plus the verifiers');
    expect(prompt).toContain('name in "uncovered"');
  });
});

/**
 * План экономии чужих CLI (22.10): рычаг `workHabits` у звена Codex / Qwen Code —
 * общая часть строки привычек Claude, без фразы про `cd`, закреплённая на первом
 * старте разговора, как у Claude (`linkEconomy`).
 */
describe('group-run-lines', () => {
  let dir: string;
  let store: AppStore;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-run-habits-')));
    store = new AppStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const link = (key: string, stage?: string): void =>
    store.setChatLink(key, {
      parentChatId: 'p',
      createdAt: '2026-10-22T10:00:00.000Z',
      ...(stage ? { stage } : {}),
    });

  it('foreign habits note follows pinned workHabits', () => {
    store.updateSettings({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, workHabits: true } });
    link('codex:on');
    const on = foreignChildExtra(store, dir, 'codex:on') ?? '';
    expect(on).toContain(FOREIGN_CHILD_PROMPT);
    expect(on).toContain(FOREIGN_GROUP_ECONOMY_PROMPT);
    expect(on.split(WORK_HABITS_SHARED_NOTE)).toHaveLength(2);
    // Фраза про `cd` — только Claude: у чужого CLI нет заметки о смене каталога.
    expect(on).not.toContain('do not `cd`');

    // Закрепляет старт прогона (`setChildRun` в runtime), не дополнение (ревью A8).
    expect(store.getChatLink('codex:on')?.economy).toBeUndefined();
    store.linkEconomy(['codex:on'], store.getSettings().groupEconomy!);
    // Выключили после первого старта — у начатого разговора строка остаётся
    // (смена посреди тёплой сессии переписала бы кэш), новый стартует без неё.
    store.updateSettings({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, workHabits: false } });
    expect(foreignChildExtra(store, dir, 'codex:on')).toBe(on);
    link('codex:off');
    const off = foreignChildExtra(store, dir, 'codex:off') ?? '';
    expect(off).toContain(FOREIGN_GROUP_ECONOMY_PROMPT);
    expect(off).not.toContain(WORK_HABITS_SHARED_NOTE);
  });

  it('foreign habits: звено, заведённое до правки, берёт рычаги своего первого хода', () => {
    // Отложенный старт (A8): дополнение строится при заведении звена, а ход —
    // позже; между ними рычаг выключили. Закрепления при заведении нет, и первый
    // ход берёт нынешние рычаги, как у Claude.
    store.updateSettings({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, workHabits: true } });
    link('codex:deferred');
    expect(foreignChildExtra(store, dir, 'codex:deferred')).toContain(WORK_HABITS_SHARED_NOTE);
    expect(store.getChatLink('codex:deferred')?.economy).toBeUndefined();
    store.updateSettings({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, workHabits: false } });
    store.linkEconomy(['codex:deferred'], store.getSettings().groupEconomy!);
    expect(foreignChildExtra(store, dir, 'codex:deferred')).not.toContain(WORK_HABITS_SHARED_NOTE);
  });

  it('foreign habits follow the declared workHabits support: aider gets none, codex and goose do', () => {
    // Ревью D (F6): у aider нет инструментов — строка о параллельных вызовах и узком
    // выводе ему не по силам, каталог зовёт рычаг «не нужен»; строка, которую он всё
    // равно получал бы, стоила бы токенов на каждом ходе. Отметка и дописка совпадают.
    store.updateSettings({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, workHabits: true } });
    for (const key of ['aider:a1', 'codex:c1', 'goose:g1']) link(key);
    const aider = foreignChildExtra(store, dir, 'aider:a1') ?? '';
    expect(aider).toContain(FOREIGN_CHILD_NO_TOOL_LOOP_PROMPT);
    expect(aider).not.toContain(WORK_HABITS_SHARED_NOTE);
    expect(foreignChildExtra(store, dir, 'codex:c1')).toContain(WORK_HABITS_SHARED_NOTE);
    expect(foreignChildExtra(store, dir, 'goose:g1')).toContain(WORK_HABITS_SHARED_NOTE);
  });

  it('aider: из строки экономии — только тетрадь и задачи трекера; остальным CLI — целиком', () => {
    // У aider один `--message` без своих инструментов: ни вызовов, ни чтений, ни
    // оболочки (`--no-suggest-shell-commands`), ни сжатия своей переписки. Фразы о
    // них ему не по силам и стоили бы токенов каждого хода; тетрадь и файл задач
    // трекера он исполняет правкой файла и добавлением его в чат.
    link('aider:a2');
    link('codex:c2');
    const aider = foreignChildExtra(store, dir, 'aider:a2') ?? '';
    expect(aider).toContain(FOREIGN_CHILD_NO_TOOL_LOOP_PROMPT);
    expect(aider).not.toContain(FOREIGN_GROUP_ECONOMY_PROMPT);
    // Оболочку панель aider выключает: просьба прогнать проверки ему не по силам.
    expect(aider).not.toContain("Run the group's checks");
    expect(foreignChildExtra(store, dir, 'codex:c2')).toContain(FOREIGN_CHILD_PROMPT);
    for (const gone of ['batch independent reads', 'timeout 1800000', 'full gate', 'compacted']) {
      expect(aider).not.toContain(gone);
    }
    expect(aider).toContain(`one line into ${TASK_NOTEBOOK}, never a secret`);
    expect(aider).toContain(`Tracker tasks: read ${TASK_TICKETS} first.`);
    expect(foreignChildExtra(store, dir, 'codex:c2')).toContain(FOREIGN_GROUP_ECONOMY_PROMPT);
  });

  it('разбор (triage) не группа — ни правил, ни привычек', () => {
    store.updateSettings({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, workHabits: true } });
    link('codex:triage', 'triage');
    const extra = foreignChildExtra(store, dir, 'codex:triage') ?? '';
    expect(extra).not.toContain(FOREIGN_CHILD_PROMPT);
    expect(extra).not.toContain(WORK_HABITS_SHARED_NOTE);
  });
});
