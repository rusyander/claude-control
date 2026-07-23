import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Group } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { renameSkill } from './skills.ts';

/**
 * Переименование скилла: имя папки — это идентификатор, поэтому меняется папка
 * на диске, а завязанные на старый id отметки в state.json (выключение,
 * гашение группой, состав групп) переезжают на новый. Кириллица и смена только
 * регистра — отдельные случаи, ради которых перенос идёт через промежуточную
 * папку. Всё во временном каталоге, настоящий ~/.claude не трогаем.
 */
describe('Переименование скилла', () => {
  let dir: string;
  let skillsDir: string;
  let disabledDir: string;
  let backupDir: string;
  let store: AppStore;

  const putSkill = (base: string, id: string, files: Record<string, string> = {}): void => {
    const skillDir = join(base, id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${id}\ndescription: x\n---\nтело`);
    for (const [rel, content] of Object.entries(files)) {
      const target = join(skillDir, rel);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-skill-rename-'));
    skillsDir = join(dir, 'skills');
    disabledDir = join(dir, 'skills-disabled');
    backupDir = join(dir, 'backups');
    mkdirSync(skillsDir, { recursive: true });
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('папка и вложенные файлы переезжают, старого id нет', () => {
    putSkill(skillsDir, 'старый-скилл', { 'references/guide.md': 'вложенный' });

    renameSkill(skillsDir, 'старый-скилл', 'новый-скилл', store);

    expect(existsSync(join(skillsDir, 'старый-скилл'))).toBe(false);
    expect(existsSync(join(skillsDir, 'новый-скилл', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(skillsDir, 'новый-скилл', 'references', 'guide.md'), 'utf8')).toBe(
      'вложенный',
    );
  });

  it('отметки (выключение, группа, гашение группой) переезжают на новый id', () => {
    putSkill(skillsDir, 'old', {});
    store.setEnabled('skill', 'old', false); // выключен вручную
    store.setGroupDisabled('skill', 'old', 'g1', true); // погашен группой g1
    store.saveGroup({
      id: 'g1',
      name: 'Группа',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'old' }],
      env: {},
      isEnabled: true,
      order: 0,
    } satisfies Group);

    renameSkill(skillsDir, 'old', 'new', store);

    // Старый id исчез из всех отметок, новый — на его месте.
    expect(store.isDisabledManually('skill', 'old')).toBe(false);
    expect(store.isDisabledManually('skill', 'new')).toBe(true);
    expect(store.disablingGroups('skill', 'old')).toEqual([]);
    expect(store.disablingGroups('skill', 'new')).toEqual(['g1']);
    expect(store.getGroupIdsFor('skill', 'old')).toEqual([]);
    expect(store.getGroupIdsFor('skill', 'new')).toEqual(['g1']);
  });

  it('занятое имя — отказ, обе папки на месте', () => {
    putSkill(skillsDir, 'first', {});
    putSkill(skillsDir, 'second', {});

    expect(() => renameSkill(skillsDir, 'first', 'second', store)).toThrow();
    expect(existsSync(join(skillsDir, 'first', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'second', 'SKILL.md'))).toBe(true);
  });

  it('пустое имя — отказ, папка не тронута', () => {
    putSkill(skillsDir, 'keep', {});

    expect(() => renameSkill(skillsDir, 'keep', '   ', store)).toThrow();
    expect(existsSync(join(skillsDir, 'keep', 'SKILL.md'))).toBe(true);
  });

  it('имя со слэшем — отказ (не выйти за пределы skills/)', () => {
    putSkill(skillsDir, 'keep', {});

    expect(() => renameSkill(skillsDir, 'keep', '../evil', store)).toThrow();
    expect(existsSync(join(skillsDir, 'keep', 'SKILL.md'))).toBe(true);
  });

  it('несуществующий скилл — отказ с кодом not_found', () => {
    let code: string | undefined;
    try {
      renameSkill(skillsDir, 'нет-такого', 'что-то', store);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('not_found');
  });

  it('выключенный скилл переименовывается прямо в skills-disabled/', () => {
    putSkill(disabledDir, 'выключенный', { 'references/n.md': 'данные' });

    renameSkill(skillsDir, 'выключенный', 'переименованный', store);

    expect(existsSync(join(disabledDir, 'выключенный'))).toBe(false);
    expect(existsSync(join(disabledDir, 'переименованный', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(disabledDir, 'переименованный', 'references', 'n.md'), 'utf8')).toBe(
      'данные',
    );
    // В основную папку skills/ его не переносим — он остаётся выключенным.
    expect(existsSync(join(skillsDir, 'переименованный'))).toBe(false);
  });

  it('резервная копия папки снимается перед переносом', () => {
    putSkill(skillsDir, 'сборка', {});

    const backupPath = renameSkill(skillsDir, 'сборка', 'релиз', store, backupDir);

    expect(backupPath).toBeDefined();
    expect(existsSync(join(backupPath!, 'SKILL.md'))).toBe(true);
  });
});
