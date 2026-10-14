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
