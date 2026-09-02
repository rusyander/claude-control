import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { saveSkill, deleteSkill, renameSkill, setSkillEnabled } from './skills.ts';

/**
 * Id скилла = имя папки, и раньше он шёл в join() как есть: `..` уводил запись
 * в корень ~/.claude (PUT /api/skills/.. создавал там SKILL.md), а DELETE с тем
 * же id снёс бы весь каталог конфигурации. Пустой id указывал на сам skills/:
 * выключение переносило бы всю папку в skills-disabled. Теперь любой id, что не
 * является одним именем папки, отвергается ДО файловых операций.
 */
describe('skills: небезопасный id', () => {
  let root: string;
  let skillsDir: string;
  let store: AppStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-skills-safe-'));
    skillsDir = join(root, 'skills');
    mkdirSync(join(skillsDir, 'good'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'good', 'SKILL.md'),
      '---\nname: good\ndescription: d\n---\n\nbody\n',
    );
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks', 'keep.txt'), 'x');
    store = new AppStore(join(root, 'claude-control'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = (): string[] =>
    (readdirSync(root, { recursive: true }) as string[]).map((p) => p.replace(/\\/g, '/')).sort();
  const thrown = (fn: () => unknown): unknown => {
    try {
      fn();
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const draft = { name: 'x', description: 'y', body: 'z', groupIds: [] as string[] };
  const BAD = ['..', '.', '', '../hooks', 'a/b', 'a\\b', 'a\0b'];
  const REJECTED = { code: 'invalid_id', statusCode: 400 };

  it.each(BAD)('saveSkill(%j) отвергается, диск не тронут', (id) => {
    const before = snapshot();
    expect(thrown(() => saveSkill(skillsDir, id, draft, join(root, 'backups')))).toMatchObject(
      REJECTED,
    );
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(root, 'SKILL.md'))).toBe(false);
  });

  it.each(BAD)('deleteSkill(%j) отвергается, диск не тронут', (id) => {
    const before = snapshot();
    expect(thrown(() => deleteSkill(skillsDir, id, join(root, 'backups')))).toMatchObject(REJECTED);
    expect(snapshot()).toEqual(before);
  });

  it.each(BAD)('setSkillEnabled(%j) отвергается, диск не тронут', (id) => {
    const before = snapshot();
    expect(thrown(() => setSkillEnabled(skillsDir, id, false))).toMatchObject(REJECTED);
    expect(thrown(() => setSkillEnabled(skillsDir, id, true))).toMatchObject(REJECTED);
    expect(snapshot()).toEqual(before);
  });

  it.each(BAD)('renameSkill(%j → «novyi») отвергается, диск не тронут', (id) => {
    const before = snapshot();
    expect(
      thrown(() => renameSkill(skillsDir, id, 'novyi', store, join(root, 'backups'))),
    ).toMatchObject(REJECTED);
    expect(snapshot()).toEqual(before);
  });

  it('обычный id по-прежнему правится, выключается и удаляется', () => {
    saveSkill(skillsDir, 'good', draft);
    setSkillEnabled(skillsDir, 'good', false);
    expect(existsSync(join(root, 'skills-disabled', 'good', 'SKILL.md'))).toBe(true);
    setSkillEnabled(skillsDir, 'good', true);
    deleteSkill(skillsDir, 'good');
    expect(existsSync(join(skillsDir, 'good'))).toBe(false);
  });
});
