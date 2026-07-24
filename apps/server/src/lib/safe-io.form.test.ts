import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readJsonFile,
  readTextFile,
  readTextForm,
  writeJsonFile,
  writeTextFile,
  providerBackupName,
  assertValidJson,
} from './safe-io.ts';
import { listBackups, resolveBackupTarget } from '../domains/backups.ts';

/**
 * Ф9/Ф10 — safe-io: форма файла и разделение резервных копий по провайдерам.
 *
 * Панель правит ЧУЖИЕ рабочие файлы, поэтому не должна менять их вид (BOM,
 * переводы строк) и не должна смешивать копии файлов разных провайдеров с
 * одинаковым basename (`settings.json` есть и у Claude, и у Gemini).
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-safeio-form-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BOM = '﻿';

describe('чтение: BOM не ломает разбор', () => {
  it('readJsonFile разбирает файл с BOM (раньше падал на валидном конфиге)', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, `${BOM}{"permissions":{"allow":["Read"]}}`, 'utf8');

    expect(readJsonFile(path, {})).toEqual({ permissions: { allow: ['Read'] } });
  });

  it('readTextFile отдаёт текст без BOM (в редактор невидимый символ не утекает)', () => {
    const path = join(dir, 'CLAUDE.md');
    writeFileSync(path, `${BOM}# Правила\n`, 'utf8');

    expect(readTextFile(path)).toBe('# Правила\n');
  });

  it('assertValidJson принимает валидный JSON с BOM', () => {
    expect(() => assertValidJson(`${BOM}{"a":1}`)).not.toThrow();
    expect(() => assertValidJson(`${BOM}{не json`)).toThrow();
  });
});

describe('запись: форма существующего файла сохраняется', () => {
  it('CRLF-файл остаётся в CRLF, BOM возвращается на место', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, `${BOM}{\r\n  "a": 1\r\n}\r\n`, 'utf8');

    writeJsonFile(path, { a: 2, b: 3 });
    const text = readFileSync(path, 'utf8');

    expect(text.startsWith(BOM)).toBe(true);
    // Ни одного «голого» LF — окончания строк не смешались.
    const crlf = (text.match(/\r\n/g) ?? []).length;
    expect((text.match(/\n/g) ?? []).length).toBe(crlf);
    expect(readJsonFile(path, {})).toEqual({ a: 2, b: 3 });
  });

  it('LF-файл остаётся в LF — поведение claude не меняется', () => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{\n  "a": 1\n}\n', 'utf8');

    writeJsonFile(path, { a: 2 });

    expect(readFileSync(path, 'utf8')).toBe('{\n  "a": 2\n}\n');
  });

  it('нового файла касается только содержимое: форму не выдумываем', () => {
    const path = join(dir, 'новый.md');
    writeTextFile(path, 'раз\r\nдва\n');

    expect(readFileSync(path, 'utf8')).toBe('раз\r\nдва\n');
    expect(readTextForm(path)).toEqual({ bom: false, eol: '\r\n' });
  });

  it('preserveForm:false пишет текст байт-в-байт (для хирургических правок)', () => {
    const path = join(dir, 'config.toml');
    writeFileSync(path, 'model = "a"\r\n', 'utf8');

    writeTextFile(path, 'model = "b"\r\nextra = 1\n', { preserveForm: false });

    expect(readFileSync(path, 'utf8')).toBe('model = "b"\r\nextra = 1\n');
  });
});

describe('резервные копии: имя провайдера разделяет файлы с одинаковым basename', () => {
  const claudeSettings = () => join(dir, 'claude', 'settings.json');
  const geminiSettings = () => join(dir, 'gemini', 'settings.json');

  it('копия провайдера не восстанавливается поверх claude-конфига', () => {
    const backupDir = join(dir, 'backups');
    writeFileSync(join(dir, 'claude-settings-src.json'), '{"claude":true}', 'utf8');

    // Копия claude — прежнее имя (её откат должен работать как раньше).
    writeTextFile(claudeSettings(), '{"claude":1}');
    writeTextFile(claudeSettings(), '{"claude":2}', { backupDir });
    // Копия gemini — с префиксом провайдера.
    writeTextFile(geminiSettings(), '{"gemini":1}');
    writeTextFile(geminiSettings(), '{"gemini":2}', {
      backupDir,
      backupName: providerBackupName('gemini', geminiSettings()),
    });

    const known = { settings: claudeSettings() };
    const entries = listBackups(backupDir, known);
    const claudeEntry = entries.find((e) => e.target === 'settings.json');
    const geminiEntry = entries.find((e) => e.target === 'gemini-settings.json');

    expect(claudeEntry?.canRestore).toBe(true);
    // Ключевое: копия gemini НЕ считается копией ~/.claude/settings.json.
    expect(geminiEntry).toBeDefined();
    expect(geminiEntry!.canRestore).toBe(false);
    expect(resolveBackupTarget('gemini-settings.json', false, known)).toBeUndefined();
  });

  it('ротация ведётся отдельно для каждого имени', () => {
    const backupDir = join(dir, 'backups');
    writeTextFile(claudeSettings(), '{"n":0}');
    writeTextFile(geminiSettings(), '{"n":0}');

    for (let i = 1; i <= 3; i += 1) {
      writeTextFile(claudeSettings(), `{"n":${i}}`, { backupDir });
      writeTextFile(geminiSettings(), `{"n":${i}}`, {
        backupDir,
        backupName: providerBackupName('gemini', geminiSettings()),
      });
    }

    const names = readdirSync(backupDir);
    expect(names.filter((n) => n.startsWith('settings.json.')).length).toBe(3);
    expect(names.filter((n) => n.startsWith('gemini-settings.json.')).length).toBe(3);
  });
});
