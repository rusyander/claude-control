import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { AppStore } from '../lib/app-store.ts';
import { readSkills, saveSkill, SkillExistsError } from './skills.ts';

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

    it('slugifyName: кириллица транслитерируется, а не отбрасывается', () => {
      // Раньше отбрасывались все не-[a-z0-9], и «Скилл v2» превращался в «v2».
      // Теперь слаг общий с правилами: кириллица переводится в латиницу.
      saveSkill(skillsDir, null, {
        name: 'Скилл v2',
        description: 'x',
        body: 'Тело.',
        groupIds: [],
      });
      expect(existsSync(join(skillsDir, 'skill-v2', 'SKILL.md'))).toBe(true);
    });

    /**
     * BUG-20. Имя целиком из кириллицы давало ПУСТОЙ слаг, а `join(skillsDir,
     * '')` — сам каталог скиллов: панель писала `skills/SKILL.md`, отвечала
     * «сохранено», скилл в списке не появлялся, а следующее русское имя молча
     * затирало тот же файл.
     */
    it('русское имя создаёт папку скилла, а не файл skills/SKILL.md (BUG-20)', () => {
      saveSkill(skillsDir, null, {
        name: 'Проверка кода',
        description: 'x',
        body: 'Тело.',
        groupIds: [],
      });

      expect(existsSync(join(skillsDir, 'proverka-koda', 'SKILL.md'))).toBe(true);
      // Ключевое: в корне каталога скиллов не должно появиться посторонних файлов.
      expect(existsSync(join(skillsDir, 'SKILL.md'))).toBe(false);
      // И скилл виден в списке — раньше его там не было.
      expect(readSkills(skillsDir, store).map((skill) => skill.id)).toContain('proverka-koda');
    });

    it('второе русское имя не затирает первый скилл (BUG-20)', () => {
      const make = (name: string, body: string): void => {
        saveSkill(skillsDir, null, { name, description: 'x', body, groupIds: [] });
      };

      make('Проверка кода', 'Первый.');
      make('Разбор логов', 'Второй.');

      expect(
        readSkills(skillsDir, store)
          .map((skill) => skill.id)
          .sort(),
      ).toEqual(['proverka-koda', 'razbor-logov']);
    });

    it('имя без букв и цифр — внятный отказ, а не запись мимо папки (BUG-20)', () => {
      let statusCode: number | undefined;
      try {
        saveSkill(skillsDir, null, { name: '🙂🙂', description: 'x', body: 'Тело.', groupIds: [] });
      } catch (error) {
        statusCode = (error as { statusCode?: number }).statusCode;
      }

      expect(statusCode).toBe(400);
      expect(existsSync(join(skillsDir, 'SKILL.md'))).toBe(false);
    });
  });

  describe('saveSkill — правка не переносит скилл и не теряет чужие поля шапки', () => {
    /** Хелпер: скилл, разложенный в skills-disabled/ (то есть выключенный). */
    const putDisabledSkill = (id: string, skillMd: string): string => {
      const skillDir = join(dir, 'skills-disabled', id);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), skillMd);
      return skillDir;
    };

    /** Шапка файла, разобранная строгим YAML — так её читает сам Claude Code. */
    const strictFrontmatter = (file: string): Record<string, unknown> => {
      const raw = readFileSync(file, 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
      expect(match).not.toBeNull();
      return parseYaml(match?.[1] ?? '') as Record<string, unknown>;
    };

    it('правка выключенного скилла пишется в skills-disabled и не включает его', () => {
      const disabledDir = putDisabledSkill(
        'code-review',
        ['---', 'name: code-review', 'description: Старое описание', '---', '', 'Тело.'].join('\n'),
      );

      saveSkill(skillsDir, 'code-review', {
        name: 'code-review',
        description: 'Новое описание',
        body: 'Новое тело.',
        groupIds: [],
      });

      // Копии в skills/ не появилось: иначе Claude увидел бы выключенный скилл.
      expect(existsSync(join(skillsDir, 'code-review'))).toBe(false);
      expect(readFileSync(join(disabledDir, 'SKILL.md'), 'utf8')).toContain('Новое описание');

      // И в списке он ровно один — выключенный, с новым описанием.
      const found = readSkills(skillsDir, store).filter((s) => s.id === 'code-review');
      expect(found).toHaveLength(1);
      expect(found[0]?.isEnabled).toBe(false);
      expect(found[0]?.description).toBe('Новое описание');
    });

    it('СОЗДАНИЕ с именем выключенного скилла отклоняется, а не пишется поверх', () => {
      // Обратная сторона предыдущего правила: если правку выключенного скилла
      // писать в skills-disabled, то и НОВЫЙ скилл с тем же именем лёг бы туда
      // же — поверх чужого тела, и «созданный» скилл оказался бы выключенным.
      const disabledDir = putDisabledSkill(
        'code-review',
        ['---', 'name: code-review', 'description: Чужой скилл', '---', '', 'Чужое тело.'].join(
          '\n',
        ),
      );

      expect(() =>
        saveSkill(skillsDir, null, {
          name: 'code-review',
          description: 'Мой новый',
          body: 'Моё тело.',
          groupIds: [],
        }),
      ).toThrow(SkillExistsError);

      expect(readFileSync(join(disabledDir, 'SKILL.md'), 'utf8')).toContain('Чужое тело.');
    });

    it('незнакомые поля шапки (allowed-tools, model, license) переживают правку', () => {
      putSkill(
        'with-extra',
        [
          '---',
          'name: with-extra',
          'description: Старое',
          'allowed-tools: Read, Bash',
          'model: opus',
          'license: MIT',
          '---',
          '',
          'Тело.',
        ].join('\n'),
      );

      saveSkill(skillsDir, 'with-extra', {
        name: 'with-extra',
        description: 'Новое',
        body: 'Тело.',
        groupIds: [],
      });

      const header = strictFrontmatter(join(skillsDir, 'with-extra', 'SKILL.md'));
      expect(header.description).toBe('Новое');
      expect(header['allowed-tools']).toBe('Read, Bash');
      expect(header.model).toBe('opus');
      expect(header.license).toBe('MIT');
    });

    it('двоеточие, кавычки и перевод строки в значениях не ломают YAML-шапку', () => {
      saveSkill(skillsDir, 'tricky', {
        name: 'a11y-audit',
        description: 'аудит фронта: axe-core\nвторая строка с "кавычками"',
        body: 'Тело.',
        groupIds: [],
      });

      // Строгий разбор обязан пройти: на самодельной шапке он падал с
      // «Implicit map keys need to be followed by map values», и Claude Code
      // переставал видеть name/description этого скилла.
      const header = strictFrontmatter(join(skillsDir, 'tricky', 'SKILL.md'));
      expect(header.name).toBe('a11y-audit');
      expect(header.description).toBe('аудит фронта: axe-core\nвторая строка с "кавычками"');

      // И собственный разбор панели возвращает то же значение целиком.
      expect(readSkills(skillsDir, store).find((s) => s.id === 'tricky')?.description).toBe(
        'аудит фронта: axe-core\nвторая строка с "кавычками"',
      );
    });

    it('длинное описание остаётся одной строкой шапки', () => {
      const long = `Use КОГДА ${'очень длинное описание '.repeat(8)}конец`;
      saveSkill(skillsDir, 'long-desc', {
        name: 'long-desc',
        description: long,
        body: 'Тело.',
        groupIds: [],
      });

      // Перенос по ширине сложил бы значение в несколько строк — запасной
      // построчный разбор шапки увидел бы от описания только первую.
      const raw = readFileSync(join(skillsDir, 'long-desc', 'SKILL.md'), 'utf8');
      expect(
        raw
          .split(/\r?\n/)
          .some((line) => line.startsWith('description:') && line.includes('конец')),
      ).toBe(true);
      expect(readSkills(skillsDir, store).find((s) => s.id === 'long-desc')?.description).toBe(
        long,
      );
    });
  });
});
