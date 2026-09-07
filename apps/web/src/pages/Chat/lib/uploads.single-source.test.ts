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
 * (`@agentdeck/contracts/uploads`). До этого копий было три — сервер, фронт
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
    // Свой перечень форматов у чужой задачи — законен: импорт результатов
    // прогонов берёт `.xml,.json,.txt`, обмен случаями — `.csv,.xlsx,.txt`, и к
    // вложениям чата это отношения не имеет. Копией списка вложений считаем
    // совпадение в половину: настоящая копия несёт все восемнадцать расширений,
    // случайное пересечение доменного списка — два-три.
    const COPY_THRESHOLD = Math.ceil(SUPPORTED_UPLOAD_EXTENSIONS.length / 2);
    // Внутри самого чата литерал запрещён при любом составе: поле выбора файла
    // обязано подставлять `UPLOAD_ACCEPT_ATTRIBUTE`, иначе копия и появится.
    const isChatCode = (path: string): boolean => /[\\/]Chat[A-Za-z]*[\\/]/.test(path);
    const looksLikeCopy = (value: string): boolean =>
      value
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => SUPPORTED_UPLOAD_EXTENSIONS.includes(part)).length >= COPY_THRESHOLD;

    // Порог проверяем тут же, иначе сторож молча ослепнет: настоящая копия
    // ловится, чужой доменный список — нет.
    expect(looksLikeCopy(UPLOAD_ACCEPT_ATTRIBUTE)).toBe(true);
    expect(looksLikeCopy('.xml,.json,.txt')).toBe(false);

    // Один тип (`application/json,.json` в импорте настроек) списком не является.
    const literal = /accept="([^"]*\.[a-z]{2,4},[^"]*)"/gi;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith('.tsx') && !path.endsWith('.ts')) continue;
        for (const match of readFileSync(path, 'utf8').matchAll(literal)) {
          if (isChatCode(path) || looksLikeCopy(match[1] ?? '')) offenders.push(path);
        }
      }
    };

    walk(webSrc);

    expect(offenders).toEqual([]);
  });
});
