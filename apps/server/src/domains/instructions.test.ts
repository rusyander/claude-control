import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import {
  resolveInstructionsTarget,
  readInstructionsInfo,
  writeInstructions,
  type InstructionsTarget,
} from './instructions.ts';

/** Фейковое хранилище настроек: активный провайдер + (нет) переопределения каталога. */
function fakeStore(provider: string, claudeDirOverride = '') {
  return { getSettings: () => ({ provider, claudeDirOverride }) };
}

describe('resolveInstructionsTarget: файл инструкций активного провайдера', () => {
  const CLAUDE_MD = join('C:', 'given', 'CLAUDE.md');

  it('claude: путь берётся из переданного location (регресс-ноль), не угадывается', () => {
    const target = resolveInstructionsTarget(fakeStore('claude'), CLAUDE_MD);
    expect(target?.filePath).toBe(CLAUDE_MD);
    expect(target?.fileName).toBe('CLAUDE.md');
    expect(target?.provider.id).toBe('claude');
  });

  it('codex: AGENTS.md в ~/.codex', () => {
    const target = resolveInstructionsTarget(fakeStore('codex'), CLAUDE_MD);
    expect(target?.filePath).toBe(join(homedir(), '.codex', 'AGENTS.md'));
    expect(target?.fileName).toBe('AGENTS.md');
    expect(target?.provider.id).toBe('codex');
  });

  it('gemini: GEMINI.md в ~/.gemini', () => {
    const target = resolveInstructionsTarget(fakeStore('gemini'), CLAUDE_MD);
    expect(target?.filePath).toBe(join(homedir(), '.gemini', 'GEMINI.md'));
    expect(target?.fileName).toBe('GEMINI.md');
  });

  it('opencode: AGENTS.md в ~/.config/opencode (Ф8)', () => {
    const target = resolveInstructionsTarget(fakeStore('opencode'), CLAUDE_MD);
    expect(target?.filePath).toBe(join(homedir(), '.config', 'opencode', 'AGENTS.md'));
    expect(target?.fileName).toBe('AGENTS.md');
    expect(target?.provider.id).toBe('opencode');
  });

  it('провайдер без задокументированного файла (cursor/aider) → undefined (fail-closed)', () => {
    // Cursor — правила лежат каталогом ~/.cursor/rules/*.mdc (иная модель),
    // Aider — глобального файла инструкций не задокументировано.
    for (const id of ['cursor', 'aider'] as const) {
      expect(resolveInstructionsTarget(fakeStore(id), CLAUDE_MD)).toBeUndefined();
    }
  });

  it('незнакомый провайдер откатывается на claude и раздел поддержан', () => {
    const target = resolveInstructionsTarget(fakeStore('nonexistent'), CLAUDE_MD);
    expect(target?.provider.id).toBe('claude');
  });
});

describe('чтение/запись инструкций codex/gemini (tmp-HOME, не настоящий ~)', () => {
  let root: string;
  let backupDir: string;

  // Цель строим руками в tmp — путь провайдера ведёт в настоящий ~, а его трогать
  // нельзя. Проверяем ровно поведение записи: создание каталога + бэкап + атомарность.
  const targetFor = (filePath: string): InstructionsTarget => ({
    provider: getProvider('codex'),
    filePath,
    fileName: basename(filePath),
    cliDetected: false,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-instructions-'));
    backupDir = join(root, 'backups');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('первая запись создаёт отсутствующий каталог и файл, бэкапа ещё нет', () => {
    const filePath = join(root, '.codex', 'AGENTS.md');
    expect(existsSync(join(root, '.codex'))).toBe(false);

    const backupPath = writeInstructions(targetFor(filePath), '# Agents\n', backupDir);

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('# Agents\n');
    // Файла раньше не было → копировать нечего.
    expect(backupPath).toBeUndefined();
  });

  it('повторная запись создаёт резервную копию прежнего содержимого', () => {
    const filePath = join(root, '.codex', 'AGENTS.md');
    writeInstructions(targetFor(filePath), 'первая версия\n', backupDir);
    const backupPath = writeInstructions(targetFor(filePath), 'вторая версия\n', backupDir);

    expect(backupPath).toBeDefined();
    expect(existsSync(backupPath!)).toBe(true);
    expect(readFileSync(backupPath!, 'utf8')).toBe('первая версия\n');
    const backups = readdirSync(backupDir).filter((name) => name.endsWith('.bak'));
    expect(backups.length).toBe(1);
  });

  it('round-trip read→write→read стабилен', () => {
    const filePath = join(root, '.codex', 'AGENTS.md');
    const target = targetFor(filePath);

    const before = readInstructionsInfo(target);
    expect(before).toMatchObject({ content: '', exists: false, providerId: 'codex' });

    writeInstructions(target, '# Инструкции\nтело\n', backupDir);
    const after = readInstructionsInfo(target);
    expect(after.content).toBe('# Инструкции\nтело\n');
    expect(after.exists).toBe(true);
    expect(after.fileName).toBe('AGENTS.md');

    // Запись того же содержимого не меняет результат чтения.
    writeInstructions(target, after.content, backupDir);
    expect(readInstructionsInfo(target).content).toBe('# Инструкции\nтело\n');
  });
});

describe('OpenCode AGENTS.md: чтение/запись/бэкап/mkdir (tmp-HOME, не настоящий ~)', () => {
  let root: string;
  let backupDir: string;

  const targetFor = (filePath: string): InstructionsTarget => ({
    provider: getProvider('opencode'),
    filePath,
    fileName: basename(filePath),
    cliDetected: false,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-opencode-md-'));
    backupDir = join(root, 'backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('каталог ~/.config/opencode создаётся ТОЛЬКО при явном сохранении; round-trip стабилен', () => {
    const dir = join(root, '.config', 'opencode');
    const filePath = join(dir, 'AGENTS.md');
    const target = targetFor(filePath);

    // До сохранения ничего не создаётся: чтение отдаёт пустой контент.
    const before = readInstructionsInfo(target);
    expect(before).toMatchObject({ content: '', exists: false, providerId: 'opencode' });
    expect(existsSync(dir)).toBe(false);

    expect(writeInstructions(target, '# Агенты\nправила\n', backupDir)).toBeUndefined();
    expect(existsSync(filePath)).toBe(true);

    const after = readInstructionsInfo(target);
    expect(after.content).toBe('# Агенты\nправила\n');
    expect(after.exists).toBe(true);
    expect(after.fileName).toBe('AGENTS.md');
    expect(after.filePath).toBe(filePath);

    // Повторная запись — бэкап прежнего содержимого, round-trip не меняет текст.
    const backupPath = writeInstructions(target, after.content, backupDir);
    expect(backupPath).toBeDefined();
    expect(readFileSync(backupPath!, 'utf8')).toBe('# Агенты\nправила\n');
    expect(readInstructionsInfo(target).content).toBe('# Агенты\nправила\n');
  });
});
