import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupEntry, setBackupKeep } from './safe-io.ts';

/**
 * Глубина ротации копий берётся из настроек панели (backupKeep) и применяется
 * глобально через setBackupKeep — при старте и при изменении настроек. Значение
 * общее на процесс, поэтому каждый тест выставляет своё и возвращает дефолт (10)
 * в afterEach, чтобы не влиять на соседей.
 */
describe('safe-io: setBackupKeep — глубина ротации', () => {
  let dir: string;
  let backupDir: string;
  let source: string;

  const stampAt = (index: number): string =>
    `2026-07-19T10-00-${String(index).padStart(2, '0')}-000Z`;

  const seed = (base: string, count: number): void => {
    mkdirSync(backupDir, { recursive: true });
    for (let index = 0; index < count; index += 1) {
      writeFileSync(join(backupDir, `${base}.${stampAt(index)}.bak`), `копия ${index}`);
    }
  };

  const bakCount = (base: string): number =>
    readdirSync(backupDir).filter((name) => name.startsWith(`${base}.`)).length;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-keep-'));
    backupDir = join(dir, 'backups');
    source = join(dir, 'settings.json');
    writeFileSync(source, '{"v":1}');
  });

  afterEach(() => {
    setBackupKeep(10); // вернуть дефолт: значение общее на процесс
    rmSync(dir, { recursive: true, force: true });
  });

  it('меньшая глубина оставляет ровно указанное число копий', () => {
    setBackupKeep(3);
    seed('settings.json', 10);

    backupEntry(source, backupDir); // +1 новая, затем ротация

    expect(bakCount('settings.json')).toBe(3);
  });

  it('глубина 1 оставляет только последнюю копию', () => {
    setBackupKeep(1);
    seed('settings.json', 5);

    backupEntry(source, backupDir);

    expect(bakCount('settings.json')).toBe(1);
  });

  it('дробное значение округляется вниз (floor)', () => {
    setBackupKeep(3.9);
    seed('settings.json', 10);

    backupEntry(source, backupDir);

    expect(bakCount('settings.json')).toBe(3);
  });

  it('значение < 1 игнорируется — сохраняется прежняя глубина', () => {
    setBackupKeep(2);
    setBackupKeep(0); // должно быть проигнорировано, остаётся 2
    seed('settings.json', 10);

    backupEntry(source, backupDir);

    expect(bakCount('settings.json')).toBe(2);
  });

  it('нечисловое/NaN значение игнорируется — сохраняется прежняя глубина', () => {
    setBackupKeep(2);
    setBackupKeep(Number.NaN);
    setBackupKeep(Number.POSITIVE_INFINITY); // не конечно — тоже игнор
    seed('settings.json', 10);

    backupEntry(source, backupDir);

    expect(bakCount('settings.json')).toBe(2);
  });

  /**
   * НАХОДКА (minor): контракт appSettingsSchema ограничивает backupKeep числом
   * 1..100, но сервер НЕ валидирует тело PATCH /api/settings через схему, а
   * setBackupKeep проверяет только нижнюю границу (>= 1). Верхнего предела на
   * сервере нет: PATCH backupKeep=100000 будет принят и панель начнёт хранить
   * 100000 копий (в т.ч. секретов) на диске. Тест ждёт клампа до 100 — сейчас
   * его нет. Снять skip после добавления верхней границы в setBackupKeep.
   */
  it('БАГ: глубина сверх контрактного максимума (100) должна ужиматься до 100', () => {
    setBackupKeep(100_000);
    seed('settings.json', 130);

    backupEntry(source, backupDir);

    // Ожидание по контракту (max 100). Фактически сейчас сохранится 131.
    expect(bakCount('settings.json')).toBeLessThanOrEqual(100);
  });
});
