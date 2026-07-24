import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import {
  readProviderRulesInfo,
  readProviderRule,
  parseProviderRuleDraft,
  saveProviderRule,
  deleteProviderRule,
  resolveRulePath,
  describeRuleError,
  RuleNotFoundError,
  RuleNotEditableError,
  UnsafeRulePathError,
  type ProviderRulesTarget,
} from './provider-rules.ts';

/**
 * CURSOR-1: инструкции как КАТАЛОГ ПРАВИЛ `.mdc` (третья модель раздела).
 *
 * Проверяем обещанное: список находит правила во вложенных подкаталогах и честно
 * помечает те, чей frontmatter не разобран; `.md` попадает в «Cursor это
 * игнорирует» и НИКОГДА не правится; создание/правка/удаление сохраняют тело и
 * чужие ключи frontmatter; защита путей отклоняет `..`, абсолютный путь, чужое
 * расширение и символическую ссылку — одинаково на запись и на удаление.
 *
 * Каталоги — временные, настоящий `~` не задействован ни на чтение, ни на запись.
 */
const RULE = `---
# правило фронтенда
description: Правила React
globs: src/**/*.tsx
alwaysApply: false
owner: team-fe
---
# Компоненты

Только функциональные.
`;

describe('cursor правила-каталог: список', () => {
  let root: string;
  let rulesDir: string;

  const target = (): ProviderRulesTarget => ({
    provider: getProvider('cursor'),
    format: 'cursor-mdc',
    scope: 'global',
    rulesDir,
    backupPrefix: 'cursor-',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-cursor-rules-'));
    rulesDir = join(root, '.cursor', 'rules');
    mkdirSync(rulesDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('находит .mdc рекурсивно и отдаёт поля frontmatter, путь и размер', () => {
    writeFileSync(join(rulesDir, 'base.mdc'), RULE, 'utf8');
    mkdirSync(join(rulesDir, 'frontend'), { recursive: true });
    writeFileSync(
      join(rulesDir, 'frontend', 'react.mdc'),
      '---\ndescription: React\nalwaysApply: true\n---\nтело\n',
      'utf8',
    );

    const info = readProviderRulesInfo(target());
    expect(info.readOnly).toBe(false);
    expect(info.dirExists).toBe(true);
    expect(info.rulesDir).toBe(rulesDir);
    expect(info.rules.map((rule) => rule.path)).toEqual(['base.mdc', 'frontend/react.mdc']);

    const nested = info.rules[1]!;
    expect(nested).toMatchObject({
      path: 'frontend/react.mdc',
      fullPath: join(rulesDir, 'frontend', 'react.mdc'),
      description: 'React',
      alwaysApply: true,
      frontmatterOk: true,
    });
    expect(nested.size).toBeGreaterThan(0);
    expect(info.rules[0]).toMatchObject({
      description: 'Правила React',
      globs: 'src/**/*.tsx',
      alwaysApply: false,
    });
  });

  it('частичный frontmatter: отсутствующие поля просто не приходят', () => {
    writeFileSync(join(rulesDir, 'only-globs.mdc'), '---\nglobs: "*.ts"\n---\nB\n', 'utf8');
    const [rule] = readProviderRulesInfo(target()).rules;
    expect(rule).toMatchObject({ globs: '*.ts', frontmatterOk: true });
    expect(rule?.description).toBeUndefined();
    expect(rule?.alwaysApply).toBeUndefined();
  });

  it('.md и прочие файлы попадают в «Cursor их игнорирует», а не в правила', () => {
    writeFileSync(join(rulesDir, 'notes.md'), '# просто заметки\n', 'utf8');
    writeFileSync(join(rulesDir, 'readme.txt'), 'текст\n', 'utf8');
    writeFileSync(join(rulesDir, 'real.mdc'), RULE, 'utf8');

    const info = readProviderRulesInfo(target());
    expect(info.rules.map((rule) => rule.path)).toEqual(['real.mdc']);
    expect(info.ignored.map((file) => file.path)).toEqual(['notes.md', 'readme.txt']);
    expect(info.ignored[0]?.fullPath).toBe(join(rulesDir, 'notes.md'));
  });

  it('правило с непонятным frontmatter помечено честно и остаётся на диске', () => {
    const broken = join(rulesDir, 'broken.mdc');
    writeFileSync(broken, '---\nalwaysApply: конечно\n---\nтело\n', 'utf8');
    writeFileSync(join(rulesDir, 'plain.mdc'), '# без frontmatter\n', 'utf8');

    const info = readProviderRulesInfo(target());
    expect(info.rules).toEqual([
      expect.objectContaining({ path: 'broken.mdc', frontmatterOk: false, problem: 'malformed' }),
      expect.objectContaining({
        path: 'plain.mdc',
        frontmatterOk: false,
        problem: 'no_frontmatter',
      }),
    ]);
    expect(readFileSync(broken, 'utf8')).toBe('---\nalwaysApply: конечно\n---\nтело\n');
  });

  it('каталога ещё нет → пустой список без ошибки, каталог НЕ создаётся', () => {
    rmSync(rulesDir, { recursive: true, force: true });
    const info = readProviderRulesInfo(target());
    expect(info).toMatchObject({ dirExists: false, rules: [], ignored: [], readOnly: false });
    expect(existsSync(rulesDir)).toBe(false);
  });
});

describe('cursor правила-каталог: безопасность путей', () => {
  let root: string;
  let rulesDir: string;

  const target = (): ProviderRulesTarget => ({
    provider: getProvider('cursor'),
    format: 'cursor-mdc',
    scope: 'global',
    rulesDir,
    backupPrefix: 'cursor-',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-cursor-safe-'));
    rulesDir = join(root, '.cursor', 'rules');
    mkdirSync(rulesDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('отклоняет пустое имя, `..`, абсолютный путь и не-.mdc', () => {
    const rejected = [
      '',
      '   ',
      '..',
      '../escape.mdc',
      'frontend/../../escape.mdc',
      './rule.mdc',
      '/etc/passwd.mdc',
      'C:\\Windows\\evil.mdc',
      '\\\\сервер\\шара\\evil.mdc',
      '..\\escape.mdc',
      'notes.md',
      'script.js',
      '.mdc',
      'sub//rule.mdc',
    ];
    for (const path of rejected) {
      expect(() => resolveRulePath(target(), path), path).toThrowError(UnsafeRulePathError);
    }
  });

  it('разрешает вложенный путь внутри каталога', () => {
    expect(resolveRulePath(target(), 'frontend/react.mdc')).toBe(
      join(rulesDir, 'frontend', 'react.mdc'),
    );
    // Разделитель Windows тоже принимается — результат тот же.
    expect(resolveRulePath(target(), 'frontend\\react.mdc')).toBe(
      join(rulesDir, 'frontend', 'react.mdc'),
    );
  });

  it('запись и удаление по небезопасному пути ничего не трогают', () => {
    const outside = join(root, 'escape.mdc');
    writeFileSync(outside, 'чужой файл\n', 'utf8');

    expect(() =>
      saveProviderRule(target(), { path: '../escape.mdc', body: 'взлом\n' }, undefined),
    ).toThrowError(UnsafeRulePathError);
    expect(() => deleteProviderRule(target(), '../escape.mdc', undefined)).toThrowError(
      UnsafeRulePathError,
    );
    expect(readFileSync(outside, 'utf8')).toBe('чужой файл\n');
    expect(existsSync(outside)).toBe(true);
  });

  it('удаление отклоняет чужое расширение: .md рядом с правилами не стирается', () => {
    const notes = join(rulesDir, 'notes.md');
    writeFileSync(notes, '# заметки\n', 'utf8');
    expect(() => deleteProviderRule(target(), 'notes.md', undefined)).toThrowError(
      UnsafeRulePathError,
    );
    expect(existsSync(notes)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'символическая ссылка в сегменте пути отклоняется (POSIX)',
    () => {
      const outsideDir = join(root, 'outside');
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(outsideDir, 'evil.mdc'), '---\n---\nчужое\n', 'utf8');
      symlinkSync(outsideDir, join(rulesDir, 'link'), 'dir');

      expect(() => resolveRulePath(target(), 'link/evil.mdc')).toThrowError(UnsafeRulePathError);
      expect(() =>
        saveProviderRule(target(), { path: 'link/evil.mdc', body: 'взлом\n' }, undefined),
      ).toThrowError(UnsafeRulePathError);
      expect(readFileSync(join(outsideDir, 'evil.mdc'), 'utf8')).toBe('---\n---\nчужое\n');
      // Обход каталога по ссылке тоже не идёт: чужого правила в списке нет.
      expect(readProviderRulesInfo(target()).rules).toEqual([]);
    },
  );

  it('небезопасный путь всегда 400 unsafe_path, а не 404', () => {
    expect(describeRuleError(new UnsafeRulePathError('../x.mdc', 'тест'))).toMatchObject({
      status: 400,
      body: { error: 'unsafe_path' },
    });
    expect(describeRuleError(new RuleNotFoundError('x.mdc'))).toMatchObject({ status: 404 });
    expect(describeRuleError(new RuleNotEditableError('x.mdc', 'malformed', 'т'))).toMatchObject({
      status: 422,
      body: { error: 'rule_read_only', problem: 'malformed' },
    });
    expect(describeRuleError(new Error('чужая ошибка'))).toBeUndefined();
  });
});

describe('cursor правила-каталог: чтение и запись одного правила', () => {
  let root: string;
  let rulesDir: string;
  let backupDir: string;

  const target = (): ProviderRulesTarget => ({
    provider: getProvider('cursor'),
    format: 'cursor-mdc',
    scope: 'global',
    rulesDir,
    backupPrefix: 'cursor-',
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-cursor-rule-'));
    rulesDir = join(root, '.cursor', 'rules');
    backupDir = join(root, 'backups');
    mkdirSync(rulesDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('отдаёт поля frontmatter отдельно от тела и перечисляет чужие ключи', () => {
    writeFileSync(join(rulesDir, 'base.mdc'), RULE, 'utf8');
    const rule = readProviderRule(target(), 'base.mdc');
    expect(rule).toMatchObject({
      path: 'base.mdc',
      fullPath: join(rulesDir, 'base.mdc'),
      description: 'Правила React',
      globs: 'src/**/*.tsx',
      alwaysApply: false,
      body: '# Компоненты\n\nТолько функциональные.\n',
      otherKeys: ['owner'],
      readOnly: false,
    });
  });

  it('правила нет → RuleNotFoundError, файл не создаётся', () => {
    expect(() => readProviderRule(target(), 'нет.mdc')).toThrowError(RuleNotFoundError);
    expect(existsSync(join(rulesDir, 'нет.mdc'))).toBe(false);
  });

  it('нераспознанный frontmatter → правило только для чтения, тело отдаётся целиком', () => {
    const text = '---\nalwaysApply: конечно\n---\nтело\n';
    writeFileSync(join(rulesDir, 'broken.mdc'), text, 'utf8');
    const rule = readProviderRule(target(), 'broken.mdc');
    expect(rule.readOnly).toBe(true);
    expect(rule.problem).toBe('malformed');
    expect(rule.body).toBe(text);
  });

  it('нераспознанное правило НЕ переписывается: 422 и файл байт-в-байт прежний', () => {
    const path = join(rulesDir, 'broken.mdc');
    const text = '---\nalwaysApply: конечно\n---\nтело\n';
    writeFileSync(path, text, 'utf8');

    expect(() =>
      saveProviderRule(
        target(),
        { path: 'broken.mdc', description: 'x', body: 'новое' },
        backupDir,
      ),
    ).toThrowError(RuleNotEditableError);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('файл без frontmatter тоже не переписывается (Cursor его и не читает)', () => {
    const path = join(rulesDir, 'plain.mdc');
    writeFileSync(path, '# без frontmatter\n', 'utf8');
    expect(() =>
      saveProviderRule(target(), { path: 'plain.mdc', body: 'новое' }, backupDir),
    ).toThrowError(RuleNotEditableError);
    expect(readFileSync(path, 'utf8')).toBe('# без frontmatter\n');
  });

  it('создание правила во вложенном подкаталоге — каталог появляется только тут', () => {
    expect(existsSync(join(rulesDir, 'frontend'))).toBe(false);
    const saved = saveProviderRule(
      target(),
      {
        path: 'frontend/react.mdc',
        description: 'React',
        globs: 'src/**/*.tsx',
        alwaysApply: true,
        body: '# React\n',
      },
      backupDir,
    );

    expect(saved.path).toBe('frontend/react.mdc');
    expect(readFileSync(join(rulesDir, 'frontend', 'react.mdc'), 'utf8')).toBe(
      '---\ndescription: React\nglobs: src/**/*.tsx\nalwaysApply: true\n---\n# React\n',
    );
    // Новый файл — копировать было нечего.
    expect(saved.backupPath).toBeUndefined();
  });

  it('правка сохраняет тело, комментарии и чужие ключи, делает копию', () => {
    const path = join(rulesDir, 'base.mdc');
    writeFileSync(path, RULE, 'utf8');

    const saved = saveProviderRule(
      target(),
      {
        path: 'base.mdc',
        description: 'Обновлено',
        globs: 'src/**/*.tsx',
        alwaysApply: true,
        body: readProviderRule(target(), 'base.mdc').body,
      },
      backupDir,
    );

    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# правило фронтенда');
    expect(text).toContain('owner: team-fe');
    expect(text).toContain('description: Обновлено');
    expect(text).toContain('alwaysApply: true');
    expect(readProviderRule(target(), 'base.mdc').body).toBe(
      '# Компоненты\n\nТолько функциональные.\n',
    );
    expect(saved.backupPath).toBeDefined();
    expect(readdirSync(backupDir)).toEqual([expect.stringMatching(/^cursor-base\.mdc\./)]);
    // Временных файлов атомарной записи не остаётся.
    expect(readdirSync(rulesDir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('копия вложенного правила именуется по всему относительному пути', () => {
    mkdirSync(join(rulesDir, 'frontend'), { recursive: true });
    writeFileSync(join(rulesDir, 'frontend', 'react.mdc'), '---\n---\nB\n', 'utf8');
    saveProviderRule(target(), { path: 'frontend/react.mdc', body: 'B2\n' }, backupDir);
    expect(readdirSync(backupDir)).toEqual([
      expect.stringMatching(/^cursor-frontend-react\.mdc\./),
    ]);
  });

  it('BOM и CRLF исходного файла сохраняются', () => {
    const path = join(rulesDir, 'crlf.mdc');
    writeFileSync(path, '\ufeff---\r\ndescription: было\r\n---\r\nтело\r\n', 'utf8');

    saveProviderRule(
      target(),
      { path: 'crlf.mdc', description: 'стало', body: 'тело\n' },
      backupDir,
    );

    const raw = readFileSync(path, 'utf8');
    expect(raw.charCodeAt(0)).toBe(0xfeff);
    expect(raw).toContain('\r\n');
    expect(raw.replace(/\r\n/g, '\n')).toBe('\ufeff---\ndescription: стало\n---\nтело\n');
  });

  it('пустые поля удаляют ключи, а не пишут умолчания', () => {
    const path = join(rulesDir, 'base.mdc');
    writeFileSync(path, RULE, 'utf8');
    saveProviderRule(target(), { path: 'base.mdc', body: 'тело\n' }, backupDir);

    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('description:');
    expect(text).not.toContain('globs:');
    expect(text).not.toContain('alwaysApply:');
    expect(text).toContain('owner: team-fe');
  });

  it('удаление правила: копия сделана, файл исчез, подкаталог остался', () => {
    mkdirSync(join(rulesDir, 'frontend'), { recursive: true });
    const path = join(rulesDir, 'frontend', 'react.mdc');
    writeFileSync(path, RULE, 'utf8');

    const removed = deleteProviderRule(target(), 'frontend/react.mdc', backupDir);
    expect(removed.path).toBe('frontend/react.mdc');
    expect(removed.backupPath).toBeDefined();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(rulesDir, 'frontend'))).toBe(true);
    expect(readdirSync(backupDir)).toEqual([
      expect.stringMatching(/^cursor-frontend-react\.mdc\./),
    ]);
  });

  it('удаление несуществующего правила → RuleNotFoundError', () => {
    expect(() => deleteProviderRule(target(), 'нет.mdc', backupDir)).toThrowError(
      RuleNotFoundError,
    );
  });

  it('черновик проверяется до касания файла', () => {
    expect(parseProviderRuleDraft(undefined)).toBeUndefined();
    expect(parseProviderRuleDraft({ body: 'x' })).toBeUndefined();
    expect(parseProviderRuleDraft({ path: '  ', body: 'x' })).toBeUndefined();
    expect(parseProviderRuleDraft({ path: 'a.mdc' })).toBeUndefined();
    expect(parseProviderRuleDraft({ path: 'a.mdc', body: 1 })).toBeUndefined();
    expect(parseProviderRuleDraft({ path: 'a.mdc', body: '', alwaysApply: 'да' })).toBeUndefined();
    expect(
      parseProviderRuleDraft({ path: 'a.mdc', body: '', description: 'две\nстроки' }),
    ).toBeUndefined();
    expect(parseProviderRuleDraft({ path: 'a.mdc', body: '', globs: 'a\nb' })).toBeUndefined();
    // Пустое тело — осознанно допустимо: правило может состоять из frontmatter.
    expect(parseProviderRuleDraft({ path: 'a.mdc', body: '' })).toEqual({
      path: 'a.mdc',
      body: '',
    });
  });
});
