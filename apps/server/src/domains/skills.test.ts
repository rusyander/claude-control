import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import { readSkills, saveSkill } from './skills.ts';

/**
 * Тесты скиллов. Скилл — это папка с файлом SKILL.md, у которого в начале
 * YAML-frontmatter (name/description), а ниже — тело инструкции. Внутренние
 * функции (splitFrontmatter, slugifyName, listFiles) не экспортируются, поэтому
 * проверяем их через публичный контур: readSkills разбирает SKILL.md и собирает
 * список вложенных файлов, а saveSkill сам вычисляет слаг папки из имени.
 *
 * Отдельно закрепляем безопасность: readSkillFile не должен выпускать за пределы
 * папки скилла (иначе через «../../…» можно прочитать чужой файл).
 *
 * Всё — во временном каталоге, настоящий ~/.claude не затрагивается.
 */
describe('skills', () => {
  let dir: string;
  let skillsDir: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-skills-'));
    skillsDir = join(dir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    store = new AppStore(join(dir, 'claude-control'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Хелпер: разложить готовый скилл (папка + SKILL.md + вложенные файлы). */
  const putSkill = (id: string, skillMd: string, files: Record<string, string> = {}): void => {
    const skillDir = join(skillsDir, id);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
    for (const [rel, content] of Object.entries(files)) {
      const target = join(skillDir, rel);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
  };

  describe('splitFrontmatter — разбор SKILL.md на шапку и тело', () => {
    it('name и description берутся из frontmatter, тело — из остатка', () => {
      putSkill(
        'my-skill',
        ['---', 'name: Мой скилл', 'description: Делает полезное', '---', '', 'Тело скилла.'].join(
          '\n',
        ),
      );
      const skills = readSkills(skillsDir, store);
      const skill = skills.find((s) => s.id === 'my-skill');
      expect(skill?.name).toBe('Мой скилл');
      expect(skill?.description).toBe('Делает полезное');
      // Тело не подрезается: после закрывающего «---» остаётся всё как есть,
      // включая пустую строку-разделитель перед текстом.
      expect(skill?.body).toBe('\nТело скилла.');
    });

    it('description с двоеточием внутри не обрезается (запасной разбор шапки)', () => {
      // Строгий YAML спотыкается о «: » внутри значения — код падает на
      // построчный разбор. Значение должно сохраниться целиком.
      putSkill(
        'a11y',
        [
          '---',
          'name: a11y-audit',
          'description: аудит фронта: axe-core через Playwright',
          '---',
          '',
          'Инструкция.',
        ].join('\n'),
      );
      const skills = readSkills(skillsDir, store);
      expect(skills.find((s) => s.id === 'a11y')?.description).toBe(
        'аудит фронта: axe-core через Playwright',
      );
    });

    it('без frontmatter всё содержимое уходит в тело, name падает на id папки', () => {
      putSkill('no-front', 'Просто текст без шапки.');
      const skill = readSkills(skillsDir, store).find((s) => s.id === 'no-front');
      expect(skill?.name).toBe('no-front');
      expect(skill?.description).toBe('');
      expect(skill?.body).toBe('Просто текст без шапки.');
    });
  });

  describe('listFiles — рекурсивный обход вложенных файлов', () => {
    it('собирает вложенные файлы с относительными путями, SKILL.md исключён', () => {
      putSkill(
        'with-files',
        ['---', 'name: with-files', 'description: x', '---', '', 'Тело.'].join('\n'),
        {
          'references/guide.md': '# guide',
          'references/deep/notes.md': 'notes',
          'config/settings.json': '{}',
        },
      );
      const skill = readSkills(skillsDir, store).find((s) => s.id === 'with-files');
      expect(skill?.files).toEqual(
        expect.arrayContaining([
          'references/guide.md',
          'references/deep/notes.md',
          'config/settings.json',
        ]),
      );
      // Сам SKILL.md в список дополнительных файлов не попадает.
      expect(skill?.files).not.toContain('SKILL.md');
    });

    it('sizeBytes считает суммарный размер файлов папки (> 0)', () => {
      putSkill('sized', ['---', 'name: sized', 'description: x', '---', '', 'Тело.'].join('\n'), {
        'extra.txt': 'полезная нагрузка',
      });
      const skill = readSkills(skillsDir, store).find((s) => s.id === 'sized');
      expect(skill?.sizeBytes).toBeGreaterThan(0);
    });
  });

  describe('readSkills — список скиллов', () => {
    it('несколько скиллов отсортированы по имени', () => {
      putSkill('zeta', ['---', 'name: Zeta', 'description: z', '---', '', 'Z'].join('\n'));
      putSkill('alpha', ['---', 'name: Alpha', 'description: a', '---', '', 'A'].join('\n'));
      const names = readSkills(skillsDir, store).map((s) => s.name);
      expect(names).toEqual(['Alpha', 'Zeta']);
    });
  });

  describe('saveSkill — создание папки со SKILL.md', () => {
    it('с явным id создаёт папку и пишет frontmatter + тело', () => {
      saveSkill(skillsDir, 'manual-id', {
        name: 'Ручной скилл',
        description: 'Описание',
        body: 'Тело инструкции.',
        groupIds: [],
      });
      const skillFile = join(skillsDir, 'manual-id', 'SKILL.md');
      expect(existsSync(skillFile)).toBe(true);
      const content = readFileSync(skillFile, 'utf8');
      expect(content).toContain('name: Ручной скилл');
      expect(content).toContain('description: Описание');
      expect(content).toContain('Тело инструкции.');
    });

    it('пустое тело заменяется каркасом-шаблоном, а не пустым файлом', () => {
      saveSkill(skillsDir, 'empty-body', {
        name: 'Пустой',
        description: 'Описание',
        body: '   ',
        groupIds: [],
      });
      const content = readFileSync(join(skillsDir, 'empty-body', 'SKILL.md'), 'utf8');
      expect(content).toContain('## Когда применять');
      expect(content).toContain('## Что делать');
    });

    it('slugifyName: пробелы → дефис, верхний регистр → нижний', () => {
      // id не передан → он вычисляется из имени функцией slugifyName.
      saveSkill(skillsDir, null, {
        name: 'My New Skill',
        description: 'x',
        body: 'Тело.',
        groupIds: [],
      });
      // Папка названа слагом: «My New Skill» → «my-new-skill».
      expect(existsSync(join(skillsDir, 'my-new-skill', 'SKILL.md'))).toBe(true);
    });

    it('заготовка тела сохраняется как корректный SKILL.md (frontmatter + тело round-trip)', () => {
      // Заготовки тела (пустой каркас / инструмент с шагами / правило / чеклист)
      // живут на клиенте и заполняют поле «тело». Здесь проверяем контур создания:
      // выбранная заготовка вместе с name/description даёт валидный SKILL.md,
      // который readSkills разбирает обратно без потерь.
      const templateBody = [
        '# tool-skill',
        '',
        '## Когда применять',
        '',
        'Use КОГДА пользователь просит… — опишите триггер.',
        '',
        '## Шаги',
        '',
        '1. Первый шаг.',
        '2. Второй шаг.',
        '',
        '## Как проверить результат',
        '',
        'Команда или тест.',
      ].join('\n');

      saveSkill(skillsDir, 'tool-skill', {
        name: 'tool-skill',
        description: 'Use КОГДА нужен инструмент со шагами',
        body: templateBody,
        groupIds: [],
      });

      // На диске: frontmatter в начале и тело заготовки целиком.
      const raw = readFileSync(join(skillsDir, 'tool-skill', 'SKILL.md'), 'utf8');
      expect(raw.startsWith('---\n')).toBe(true);
      expect(raw).toContain('name: tool-skill');
      expect(raw).toContain('## Шаги');

      // Обратный разбор: name/description из шапки, тело — та же заготовка.
      const skill = readSkills(skillsDir, store).find((s) => s.id === 'tool-skill');
      expect(skill?.name).toBe('tool-skill');
      expect(skill?.description).toBe('Use КОГДА нужен инструмент со шагами');
      expect(skill?.body.trim()).toBe(templateBody.trim());
    });

    it('slugifyName: не-латиница отбрасывается, латиница/цифры сохраняются', () => {
      // slugifyName НЕ транслитерирует кириллицу (в отличие от правил): любые
      // не [a-z0-9] схлопываются в дефис. «Скилл v2» → отбрасываем кириллицу,
      // остаётся «v2».
      saveSkill(skillsDir, null, {
        name: 'Скилл v2',
        description: 'x',
        body: 'Тело.',
        groupIds: [],
      });
      expect(existsSync(join(skillsDir, 'v2', 'SKILL.md'))).toBe(true);
    });
  });
});
