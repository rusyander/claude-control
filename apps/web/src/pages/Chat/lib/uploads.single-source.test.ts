import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_UPLOAD_EXTENSIONS,
  UPLOAD_ACCEPT_ATTRIBUTE,
  isSupportedUpload,
  unsupportedUploadNames,
} from './uploads';

/**
 * Белый список расширений вложений живёт в ОДНОМ месте
 * (`@claude-control/contracts/uploads`). До этого копий было три — сервер, фронт
 * и атрибут `accept` поля выбора файла, — и расходились они молча: файл проходил
 * проверку фронта и отвергался сервером, либо диалог выбора не показывал файл,
 * который панель принимает. Тест держит именно это: список один, и в разметке
 * нет второго, написанного руками.
 */
describe('вложения чата: один источник списка расширений', () => {
  const webSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  it('accept собирается из того же списка', () => {
    expect(UPLOAD_ACCEPT_ATTRIBUTE.split(',')).toEqual([...SUPPORTED_UPLOAD_EXTENSIONS]);
  });

  it('проверки фронта используют этот же список', () => {
    for (const extension of SUPPORTED_UPLOAD_EXTENSIONS) {
      expect(isSupportedUpload(`файл${extension}`)).toBe(true);
    }
    expect(unsupportedUploadNames([{ name: 'virus.exe' }, { name: 'notes.md' }])).toEqual([
      'virus.exe',
    ]);
  });

  it('в разметке нет второго списка расширений, написанного строкой', () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith('.tsx') && !path.endsWith('.ts')) continue;
        // Атрибут `accept` со списком расширений файлов — ровно та копия,
        // которая расходилась. Один тип (`application/json,.json` в импорте
        // настроек) списком не является и тестом не ловится.
        const literal = /accept="[^"]*\.[a-z]{2,4},[^"]*"/i;
        if (literal.test(readFileSync(path, 'utf8'))) offenders.push(path);
      }
    };

    walk(webSrc);

    expect(offenders).toEqual([]);
  });
});
