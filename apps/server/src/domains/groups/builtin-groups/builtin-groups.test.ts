import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { triageStagePrompt } from '@agentdeck/contracts/split-plan';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { pickableGroups } from '../../chat/group-auto-pick/group-auto-pick.ts';
import { BUILTIN_GROUPS } from './builtin-groups.constants.ts';
import {
  builtinGroupsStatus,
  rememberBuiltinRemoved,
  restoreBuiltinGroups,
  seedBuiltinGroups,
} from './builtin-groups.ts';

/**
 * Встроенные группы доставки (владелец 20.10.2026): засев на каждый каталог
 * настроек. Закреплено то, что человек может потерять: удалённая сама не
 * возвращается, изменённая не перезаписывается, включение и порядок человека
 * переживают обновление каталога, а своя группа в «Авто» стоит впереди.
 */
describe('встроенные группы доставки', () => {
  let dir: string;
  let skillsDir: string;
  let store: AppStore;
  const deps = (): { store: AppStore; skillsDir: string } => ({ store, skillsDir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-builtin-'));
    skillsDir = join(dir, 'skills');
    store = new AppStore(join(dir, 'state'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('чистый каталог получает все семь, без участников, после групп человека', () => {
    store.saveGroup({ ...store.getGroups()[0], ...ownGroup('mine', 5) });
    const report = seedBuiltinGroups(deps());

    expect(report.added).toEqual(BUILTIN_GROUPS.map((entry) => entry.id));
    const builtins = store.getGroups().filter((group) => group.id.startsWith('builtin-'));
    expect(builtins).toHaveLength(8);
    expect(builtins.every((group) => group.members.length === 0)).toBe(true);
    expect(Math.min(...builtins.map((group) => group.order))).toBeGreaterThan(5);
    // Язык интерфейса по умолчанию — русский.
    expect(builtins[0]?.name).toBe('Задача → MR (быстро)');
  });

  it('второй проход ничего не меняет', () => {
    seedBuiltinGroups(deps());
    const before = JSON.stringify(store.getGroups());
    expect(seedBuiltinGroups(deps())).toEqual({ added: [], updated: [] });
    expect(JSON.stringify(store.getGroups())).toBe(before);
  });

  it('удалённую не засевает снова; «Вернуть встроенные» возвращает её по имени', () => {
    seedBuiltinGroups(deps());
    store.deleteGroup('builtin-mr-review');
    rememberBuiltinRemoved(store, 'builtin-mr-review');

    seedBuiltinGroups(deps());
    expect(store.getGroups().some((group) => group.id === 'builtin-mr-review')).toBe(false);
    expect(builtinGroupsStatus(store).removed).toEqual(['builtin-mr-review']);

    expect(restoreBuiltinGroups(deps())).toEqual(['Ревью чужого MR']);
    expect(builtinGroupsStatus(store).removed).toEqual([]);
  });

  it('изменённую человеком не перезаписывает даже при смене языка', () => {
    seedBuiltinGroups(deps());
    const own = store.getGroups().find((group) => group.id === 'builtin-delivery');
    store.saveGroup({ ...own!, when: 'only my tickets' });
    store.updateSettings({ language: 'en' });

    const report = seedBuiltinGroups(deps());
    const after = store.getGroups().find((group) => group.id === 'builtin-delivery');
    expect(report.updated).not.toContain('builtin-delivery');
    expect(after?.when).toBe('only my tickets');
    expect(builtinGroupsStatus(store).edited).toEqual(['builtin-delivery']);
  });

  it('нетронутую обновляет, а включение, порядок и проекты человека сохраняет', () => {
    seedBuiltinGroups(deps());
    const own = store.getGroups().find((group) => group.id === 'builtin-delivery-backend')!;
    // Это поля человека — не содержимое каталога.
    store.saveGroup({ ...own, isEnabled: false, order: 99, projectPaths: ['/p'] });
    store.updateSettings({ language: 'en' });

    const report = seedBuiltinGroups(deps());
    const after = store.getGroups().find((group) => group.id === 'builtin-delivery-backend');
    expect(report.updated).toContain('builtin-delivery-backend');
    expect(after?.name).toBe('Ticket → MR: backend');
    expect(after?.isEnabled).toBe(false);
    expect(after?.order).toBe(99);
    expect(after?.projectPaths).toEqual(['/p']);
  });

  it('шаг профиля называет свой скилл, если он есть, иначе скилл набора панели', () => {
    seedBuiltinGroups(deps());
    const stepSkill = (id: string): string | undefined =>
      store.getGroups().find((group) => group.id === id)?.path?.steps[0]?.within?.skillId;
    expect(stepSkill('builtin-delivery')).toBe('agentdeck-kit:ticket-delivery');

    mkdirSync(join(skillsDir, 'ticket-delivery'), { recursive: true });
    writeFileSync(join(skillsDir, 'ticket-delivery', 'SKILL.md'), '---\nname: x\n---\n');
    seedBuiltinGroups(deps());
    expect(stepSkill('builtin-delivery')).toBe('ticket-delivery');
    expect(stepSkill('builtin-mr-review')).toBe('agentdeck-kit:deep-review');
  });

  it('перенесённый state.json без записи: совпадает с каталогом — принят, иначе изменён', () => {
    seedBuiltinGroups(deps());
    const own = store.getGroups().find((group) => group.id === 'builtin-delivery-design')!;
    store.saveGroup({ ...own, description: 'своё' });
    store.setBuiltinGroups({ seeded: {}, removed: [] });

    seedBuiltinGroups(deps());
    expect(builtinGroupsStatus(store).edited).toEqual(['builtin-delivery-design']);
  });

  it('«Авто» помечает встроенные и ставит их после своих групп; правило старшинства в разборе', () => {
    store.saveGroup({ ...ownGroup('mine', 0), when: 'login form tickets' });
    seedBuiltinGroups(deps());
    const catalog = pickableGroups(store.getGroups(), '/p', null);

    expect(catalog[0]?.builtin).toBeUndefined();
    expect(catalog.slice(1).every((entry) => entry.builtin === true)).toBe(true);
    const prompt = triageStagePrompt({ groups: GROUPS, catalog });
    expect(prompt).toContain('A built-in group is a fallback');
    expect(prompt).toContain('— built-in');
    // Без встроенных правило не едет — в каждый разбор лишних слов не добавляем.
    expect(triageStagePrompt({ groups: GROUPS, catalog: catalog.slice(0, 1) })).not.toContain(
      'built-in',
    );
  });
});

const GROUPS = [{ title: 'a', branch: 'b', tasks: ['t'] }];

function ownGroup(id: string, order: number) {
  return {
    id,
    name: id,
    description: '',
    color: 'accent',
    icon: 'folder',
    members: [],
    env: {},
    isEnabled: true,
    order,
  };
}
