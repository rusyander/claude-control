import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import { BOM_CHAR } from '../lib/text-form.ts';
import {
  readProviderSkillsInfo,
  readProviderSkill,
  saveProviderSkill,
  deleteProviderSkill,
  parseProviderSkillDraft,
  assertSkillDraft,
  resolveSkillPath,
  InvalidSkillDraftError,
  UnsafeSkillPathError,
  SkillNotFoundError,
  SkillNotEditableError,
  type ProviderSkillsTarget,
} from './provider-skills.ts';

/**
 * OPENCODE-5: скиллы OpenCode — каталог `skills/`, папка на скилл со `SKILL.md`.
 *
 * Проверяем главное: список/чтение/создание/правка/удаление с СОХРАНЕНИЕМ
 * незнакомых полей шапки и тела; каждое правило имени (включая name≠папка) → 400;
 * границы описания; неразобранная шапка → только чтение (422, файл байт-в-байт);
 * защиту путей (`..`, абсолютный, UNC, чужая форма) одинаково на всех операциях;
 * BOM/CRLF. Всё во временных каталогах — домашний каталог не затрагивается.
 */
describe('OpenCode: скиллы (каталог skills/ со SKILL.md)', () => {
  let root: string;
  let backupDir: string;
  let target: ProviderSkillsTarget;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-skill-md-dir-'));
    backupDir = join(root, 'backups');
    target = {
      provider: getProvider('opencode'),
      format: 'skill-md-dir',
      scope: 'global',
      skillsDir: join(root, 'skills'),
      backupPrefix: 'opencode-',
      externalDirs: [join(root, 'external-claude'), join(root, 'external-agents')],
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const put = (name: string, content: string): void => {
    mkdirSync(join(target.skillsDir, name), { recursive: true });
    writeFileSync(join(target.skillsDir, name, 'SKILL.md'), content);
  };

  const save = (path: string, name: string, description: string, body: string) =>
    saveProviderSkill(target, { path, name, description, body }, backupDir);

  // --- Список -----------------------------------------------------------------

  it('каталога нет — список пуст, каталог НЕ создаётся; внешние каталоги показаны', () => {
    const info = readProviderSkillsInfo(target);
    expect(info.dirExists).toBe(false);
    expect(info.skills).toEqual([]);
    expect(info.readOnly).toBe(false);
    expect(existsSync(target.skillsDir)).toBe(false);
    // Прочие каталоги загрузки перечислены с признаком существования.
    expect(info.externalDirs).toEqual([
      { path: join(root, 'external-claude'), exists: false },
      { path: join(root, 'external-agents'), exists: false },
    ]);
  });

  it('перечисляет скиллы, папки без SKILL.md идут в ignored, а не в skills', () => {
    put('alpha', '---\nname: alpha\ndescription: Первый\n---\n\nтело\n');
    put('beta', '---\nname: beta\ndescription: Второй\n---\n');
    mkdirSync(join(target.skillsDir, 'no-manifest'), { recursive: true });

    const info = readProviderSkillsInfo(target);
    expect(info.skills.map((s) => s.dirName)).toEqual(['alpha', 'beta']);
    expect(info.skills[0]).toMatchObject({
      name: 'alpha',
      description: 'Первый',
      frontmatterOk: true,
      nameMismatch: false,
      path: 'alpha/SKILL.md',
    });
    expect(info.ignored.map((d) => d.dirName)).toEqual(['no-manifest']);
  });

  it('name ≠ имя папки — скилл читается, но помечен nameMismatch', () => {
    put('alpha', '---\nname: not-alpha\ndescription: X\n---\n');
    const info = readProviderSkillsInfo(target);
    expect(info.skills[0]).toMatchObject({ name: 'not-alpha', nameMismatch: true });
  });

  it('нет шапки / нет обязательного поля → frontmatterOk=false с точной причиной', () => {
    put('no-fm', 'просто markdown без шапки\n');
    put('no-name', '---\ndescription: есть\n---\n');
    put('no-desc', '---\nname: no-desc\n---\n');

    const byDir = new Map(readProviderSkillsInfo(target).skills.map((s) => [s.dirName, s]));
    expect(byDir.get('no-fm')).toMatchObject({ frontmatterOk: false, problem: 'no_frontmatter' });
    expect(byDir.get('no-name')).toMatchObject({ frontmatterOk: false, problem: 'missing_name' });
    expect(byDir.get('no-desc')).toMatchObject({
      frontmatterOk: false,
      problem: 'missing_description',
    });
    // У нечитаемой шапки имя = имя папки (единственное, что известно наверняка).
    expect(byDir.get('no-fm')!.name).toBe('no-fm');
  });

  // --- Round-trip с сохранением незнакомых полей ------------------------------

  it('создание round-trip: незнакомые поля шапки и тело целы', () => {
    put(
      'demo',
      [
        '---',
        'name: demo',
        'description: старое',
        'license: MIT',
        'compatibility: ">=1.0"',
        'metadata:',
        '  team: frontend',
        'custom-field: значение', // совсем чужой ключ — тоже сохранить
        '---',
        '',
        '# Тело скилла',
        'осталось как есть',
        '',
      ].join('\n'),
    );

    save('demo/SKILL.md', 'demo', 'новое описание', '# Тело скилла\nосталось как есть\n');

    const raw = readFileSync(join(target.skillsDir, 'demo', 'SKILL.md'), 'utf8');
    expect(raw).toContain('description: новое описание');
    expect(raw).toContain('license: MIT');
    expect(raw).toContain('compatibility:');
    expect(raw).toContain('team: frontend');
    expect(raw).toContain('custom-field: значение');
    expect(raw).toContain('# Тело скилла');

    const skill = readProviderSkill(target, 'demo/SKILL.md');
    expect(skill).toMatchObject({ name: 'demo', description: 'новое описание', readOnly: false });
    // Незнакомые ключи перечислены как «панель их не трогает».
    expect(skill.otherKeys.sort()).toEqual([
      'compatibility',
      'custom-field',
      'license',
      'metadata',
    ]);
  });

  it('создание нового скилла с нуля: пишет ровно name+description и тело', () => {
    save('fresh/SKILL.md', 'fresh', 'делает нечто полезное', '# Fresh\n');
    const raw = readFileSync(join(target.skillsDir, 'fresh', 'SKILL.md'), 'utf8');
    expect(raw).toBe('---\nname: fresh\ndescription: делает нечто полезное\n---\n# Fresh\n');
  });

  it('BOM и CRLF исходного файла сохраняются при записи', () => {
    const original = `${BOM_CHAR}---\r\nname: crlf\r\ndescription: было\r\n---\r\n\r\nтело\r\n`;
    put('crlf', original);
    save('crlf/SKILL.md', 'crlf', 'стало', 'тело\n');
    const raw = readFileSync(join(target.skillsDir, 'crlf', 'SKILL.md'), 'utf8');
    expect(raw.startsWith(BOM_CHAR)).toBe(true);
    expect(raw).toContain('\r\n');
    expect(raw).toContain('description: стало');
  });

  // --- Валидация имени и описания (400 ДО записи) -----------------------------

  it('каждое правило имени нарушается отдельным кодом', () => {
    const cases: Array<[string, string]> = [
      ['', 'name_empty'],
      ['-lead', 'name_leading_hyphen'],
      ['trail-', 'name_trailing_hyphen'],
      ['a--b', 'name_double_hyphen'],
      ['Upper', 'name_pattern'],
      ['under_score', 'name_pattern'],
      ['a'.repeat(65), 'name_too_long'],
    ];
    for (const [name, reason] of cases) {
      try {
        assertSkillDraft({ path: `${name}/SKILL.md`, name, description: 'ok', body: '' }, name);
        expect.unreachable(`имя «${name}» должно быть отклонено`);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidSkillDraftError);
        expect((error as InvalidSkillDraftError).reason).toBe(reason);
      }
    }
  });

  it('name обязано совпадать с именем папки → 400 name_dir_mismatch', () => {
    expect(() =>
      assertSkillDraft(
        { path: 'folder/SKILL.md', name: 'other', description: 'x', body: '' },
        'folder',
      ),
    ).toThrowError(InvalidSkillDraftError);
    try {
      assertSkillDraft(
        { path: 'folder/SKILL.md', name: 'other', description: 'x', body: '' },
        'folder',
      );
    } catch (error) {
      expect((error as InvalidSkillDraftError).reason).toBe('name_dir_mismatch');
    }
  });

  it('описание: пустое и длиннее 1024 отклоняются', () => {
    expect(() =>
      assertSkillDraft({ path: 'a/SKILL.md', name: 'a', description: '   ', body: '' }, 'a'),
    ).toThrowError(InvalidSkillDraftError);
    expect(() =>
      assertSkillDraft(
        { path: 'a/SKILL.md', name: 'a', description: 'd'.repeat(1025), body: '' },
        'a',
      ),
    ).toThrowError(InvalidSkillDraftError);
  });

  it('saveProviderSkill отклоняет невалидное имя ДО записи — файл не создан', () => {
    expect(() => save('Bad_Name/SKILL.md', 'Bad_Name', 'x', '')).toThrowError(
      InvalidSkillDraftError,
    );
    expect(existsSync(join(target.skillsDir, 'Bad_Name'))).toBe(false);
  });

  // --- Только чтение при неразобранной шапке ----------------------------------

  it('шапка не разобрана → readProviderSkill readOnly, тело = весь файл', () => {
    put('broken', 'нет шапки, просто текст\n');
    const skill = readProviderSkill(target, 'broken/SKILL.md');
    expect(skill).toMatchObject({ readOnly: true, problem: 'no_frontmatter' });
    expect(skill.body).toBe('нет шапки, просто текст\n');
  });

  it('перезапись скилла с неразобранной шапкой запрещена (422), файл байт-в-байт', () => {
    const before = 'мусор вместо шапки\n';
    put('broken', before);
    expect(() => save('broken/SKILL.md', 'broken', 'x', 'y')).toThrowError(SkillNotEditableError);
    expect(readFileSync(join(target.skillsDir, 'broken', 'SKILL.md'), 'utf8')).toBe(before);
  });

  // --- Удаление ---------------------------------------------------------------

  it('удаление стирает ТОЛЬКО папку скилла, сделав резервную копию', () => {
    put('alpha', '---\nname: alpha\ndescription: X\n---\n');
    put('beta', '---\nname: beta\ndescription: Y\n---\n');
    const { backupPath } = deleteProviderSkill(target, 'alpha/SKILL.md', backupDir);
    expect(backupPath && existsSync(backupPath)).toBe(true);
    expect(existsSync(join(target.skillsDir, 'alpha'))).toBe(false);
    // Соседний скилл и сам каталог целы.
    expect(existsSync(join(target.skillsDir, 'beta'))).toBe(true);
    expect(existsSync(target.skillsDir)).toBe(true);
  });

  it('удаление несуществующего скилла → SkillNotFoundError', () => {
    mkdirSync(target.skillsDir, { recursive: true });
    expect(() => deleteProviderSkill(target, 'ghost/SKILL.md', backupDir)).toThrowError(
      SkillNotFoundError,
    );
  });

  // --- Защита путей -----------------------------------------------------------

  it('небезопасные пути отвергаются ОДИНАКОВО на чтении, записи и удалении', () => {
    const unsafe = [
      '../evil/SKILL.md',
      '/abs/SKILL.md',
      'C:/win/SKILL.md',
      '\\\\server\\share\\SKILL.md',
      'a/b/SKILL.md', // не форма <имя>/SKILL.md (лишний сегмент)
      'lone/README.md', // не SKILL.md
      'justname', // один сегмент
      'a//SKILL.md', // пустой сегмент
      './SKILL.md',
    ];
    for (const path of unsafe) {
      expect(() => resolveSkillPath(target, path), path).toThrowError(UnsafeSkillPathError);
      expect(() => readProviderSkill(target, path), path).toThrowError(UnsafeSkillPathError);
      expect(() => save(path, 'x', 'y', ''), path).toThrowError(UnsafeSkillPathError);
      expect(() => deleteProviderSkill(target, path, backupDir), path).toThrowError(
        UnsafeSkillPathError,
      );
    }
    // Ничего снаружи каталога не создано.
    expect(existsSync(join(root, 'evil'))).toBe(false);
  });

  it('валидная форма <имя>/SKILL.md резолвится внутрь каталога', () => {
    expect(resolveSkillPath(target, 'good/SKILL.md')).toBe(
      join(target.skillsDir, 'good', 'SKILL.md'),
    );
  });

  // --- Разбор черновика -------------------------------------------------------

  it('parseProviderSkillDraft отвергает переводы строк и лишние типы', () => {
    expect(
      parseProviderSkillDraft({ path: 'a/SKILL.md', name: 'a', description: 'd', body: '' }),
    ).toEqual({ path: 'a/SKILL.md', name: 'a', description: 'd', body: '' });
    // Перевод строки в имени/описании ломает форму шапки.
    expect(
      parseProviderSkillDraft({ path: 'a/SKILL.md', name: 'a\nb', description: 'd', body: '' }),
    ).toBeUndefined();
    expect(
      parseProviderSkillDraft({ path: 'a/SKILL.md', name: 'a', description: 'd\ne', body: '' }),
    ).toBeUndefined();
    // Отсутствующее тело — запрос неполон.
    expect(
      parseProviderSkillDraft({ path: 'a/SKILL.md', name: 'a', description: 'd' }),
    ).toBeUndefined();
    expect(parseProviderSkillDraft(null)).toBeUndefined();
    expect(parseProviderSkillDraft([])).toBeUndefined();
  });
});
