import { describe, it, expect } from 'vitest';
import { templatesFor, templateById, RESOURCE_TEMPLATES } from './templates.ts';

/**
 * Тесты заготовок структуры. Главное свойство скилла: Claude Code не читает
 * вложенные файлы сам — на них должны быть ссылки из SKILL.md. Шаблоны с
 * модулями обязаны это соблюдать, иначе созданная структура «немая».
 */
describe('resource templates', () => {
  it('для скилла есть простой шаблон и шаблон с модулями', () => {
    const ids = templatesFor('skill').map((t) => t.id);
    expect(ids).toContain('skill-minimal');
    expect(ids).toContain('skill-references');
  });

  it('templateById находит шаблон', () => {
    expect(templateById('skill-minimal')?.kind).toBe('skill');
    expect(templateById('nope')).toBeUndefined();
  });

  it('каждый шаблон скилла содержит SKILL.md', () => {
    for (const template of templatesFor('skill')) {
      expect(template.files.some((f) => f.path === 'SKILL.md')).toBe(true);
    }
  });

  it('SKILL.md ссылается на все вложенные файлы шаблона', () => {
    // Иначе Claude Code вложенный файл не подхватит — он «висит» мёртвым грузом.
    for (const template of RESOURCE_TEMPLATES.filter((t) => t.kind === 'skill')) {
      const skill = template.files.find((f) => f.path === 'SKILL.md');
      const nested = template.files.filter((f) => f.path !== 'SKILL.md');

      for (const file of nested) {
        expect(
          skill?.content,
          `${template.id}: SKILL.md должен ссылаться на ${file.path}`,
        ).toContain(file.path);
      }
    }
  });

  it('frontmatter шаблона содержит name и description', () => {
    for (const template of templatesFor('skill')) {
      const skill = template.files.find((f) => f.path === 'SKILL.md');
      expect(skill?.content).toMatch(/name:/);
      expect(skill?.content).toMatch(/description:/);
    }
  });
});
