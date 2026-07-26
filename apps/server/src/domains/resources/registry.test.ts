import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { safeSegment, resourceRoot, layoutOf } from './registry.ts';

/**
 * Тесты идентификатора ресурса. safeSegment — первая линия защиты: он не должен
 * превращать чужой ввод в путь к корню каталога или наружу.
 *
 * Второй заход аудита нашёл здесь обратную ошибку: имя не проверялось, а
 * «чинилось» вырезанием символов. Идентификатор скилла — это имя его папки,
 * которое даёт пользователь, поэтому кириллица тут обычное дело: `мой-skill`
 * превращался в `-skill` (пустое дерево у существующего скилла, папка-призрак
 * при записи), а разные имена схлопывались в одно и то же.
 */
describe('registry.safeSegment', () => {
  it('пропускает нормальное имя', () => {
    expect(safeSegment('frontend-architecture')).toBe('frontend-architecture');
  });

  it('оставляет допустимые символы имени плагина', () => {
    expect(safeSegment('code-review@claude-plugins')).toBe('code-review@claude-plugins');
  });

  it('кириллица в имени сохраняется целиком, а не обрезается до огрызка', () => {
    // Регрессия: раньше возвращалось `-skill` — путь к несуществующей папке.
    expect(safeSegment('мой-skill')).toBe('мой-skill');
  });

  it('нелатинское имя без латиницы — обычное имя папки, а не отказ', () => {
    expect(safeSegment('правила')).toBe('правила');
    expect(safeSegment('🎉')).toBe('🎉');
  });

  it('разные имена не схлопываются в одно', () => {
    // Раньше оба давали `-skill`, и правки одного скилла уезжали в другой.
    expect(safeSegment('мой-skill')).not.toBe(safeSegment('твой-skill'));
  });

  it('пустая строка отвергается', () => {
    expect(safeSegment('')).toBeUndefined();
  });

  it('точки отвергаются целиком', () => {
    expect(safeSegment('.')).toBeUndefined();
    expect(safeSegment('..')).toBeUndefined();
    expect(safeSegment('...')).toBeUndefined();
  });

  it('разделители пути отвергают имя целиком, а не вычищаются из него', () => {
    // Раньше `a/../b` превращалось в `a..b` — существующее, но чужое имя.
    expect(safeSegment('a/../b')).toBeUndefined();
    expect(safeSegment('../../etc')).toBeUndefined();
    expect(safeSegment('a\\b')).toBeUndefined();
  });

  it('двоеточие отвергается: на NTFS это альтернативный поток чужого файла', () => {
    expect(safeSegment('demo:stream')).toBeUndefined();
  });

  it('управляющий символ в имени отвергается', () => {
    expect(safeSegment(`demo${String.fromCharCode(0)}`)).toBeUndefined();
    expect(safeSegment(`demo${String.fromCharCode(10)}x`)).toBeUndefined();
  });
});

describe('registry.resourceRoot', () => {
  // Абсолютный путь на любой системе: на Windows подставится буква текущего диска.
  const base = resolve(sep, 'claude-test', 'skills');

  it('обычное имя даёт папку внутри корня', () => {
    expect(resourceRoot(base, 'мой-skill')).toBe(join(base, 'мой-skill'));
  });

  it('за пределы корня не выпускает', () => {
    expect(resourceRoot(base, '..')).toBeUndefined();
    expect(resourceRoot(base, '../../etc')).toBeUndefined();
  });

  it('сам корень ресурсом не считается', () => {
    // Иначе операция ушла бы не на скилл, а на всю папку скиллов.
    expect(resourceRoot(base, '.')).toBeUndefined();
  });

  it('результат всегда строго внутри базовой папки', () => {
    const root = resourceRoot(base, 'demo');
    expect(root?.startsWith(`${base}${sep}`)).toBe(true);
  });
});

describe('registry.layoutOf', () => {
  it('знает свои виды', () => {
    expect(layoutOf('skill')?.isDirectory).toBe(true);
    expect(layoutOf('script')?.isDirectory).toBe(false);
  });

  it('плагин — только чтение', () => {
    expect(layoutOf('plugin')?.isWritable).toBe(false);
  });

  it('скилл и скрипт — с записью', () => {
    expect(layoutOf('skill')?.isWritable).toBe(true);
    expect(layoutOf('script')?.isWritable).toBe(true);
  });

  it('неизвестный вид — undefined', () => {
    expect(layoutOf('nonsense')).toBeUndefined();
  });
});
