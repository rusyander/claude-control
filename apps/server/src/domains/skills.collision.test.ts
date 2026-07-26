import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveSkill, SkillExistsError } from './skills.ts';

/**
 * Слаг папки считается из имени и режется до 60 символов, поэтому два разных
 * длинных имени легко дают один id. Создание по занятому слагу обязано быть
 * отказом: молча записанный поверх скилл — потеря чужой работы, которую ничто
 * не подсказывает (в списке остаётся одна строка, тело — новое).
 */
describe('saveSkill — создание не затирает существующий скилл', () => {
  let dir: string;
  let skillsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-skill-collision-'));
    skillsDir = join(dir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const long = (tail: string): string =>
    `Очень подробное руководство по стилю фронтенда команды, ${tail}`;

  it('второе имя с тем же слагом отклоняется, тело первого не тронуто', () => {
    saveSkill(skillsDir, null, {
      name: long('часть первая'),
      description: 'Первый',
      body: 'Тело первого.',
      groupIds: [],
    });

    expect(() =>
      saveSkill(skillsDir, null, {
        name: long('часть вторая'),
        description: 'Второй',
        body: 'Тело второго.',
        groupIds: [],
      }),
    ).toThrow(SkillExistsError);

    const [id] = readdirSync(skillsDir);
    expect(readFileSync(join(skillsDir, id!, 'SKILL.md'), 'utf8')).toContain('Тело первого.');
  });

  it('правка существующего скилла (id передан) по-прежнему пишется поверх', () => {
    mkdirSync(join(skillsDir, 'my-skill'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: было\n---\n\nСтарое тело.\n',
    );

    saveSkill(skillsDir, 'my-skill', {
      name: 'my-skill',
      description: 'стало',
      body: 'Новое тело.',
      groupIds: [],
    });

    expect(readFileSync(join(skillsDir, 'my-skill', 'SKILL.md'), 'utf8')).toContain('Новое тело.');
  });
});
