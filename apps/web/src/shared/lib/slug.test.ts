import { describe, it, expect } from 'vitest';
import { slugify } from './slug';

/**
 * Слаг обязан совпадать с серверным: по нему фронт открывает дерево файлов
 * только что созданного скилла. Урезанная версия отбрасывала кириллицу, и на
 * русском имени id получался пустым — дерево не открывалось, заготовка
 * структуры не применялась.
 */
describe('slugify', () => {
  it('транслитерирует кириллицу, а не отбрасывает её', () => {
    expect(slugify('Проверка кода')).toBe('proverka-koda');
    expect(slugify('Ёжик и щука')).toBe('ezhik-i-schuka');
  });

  it('латиница и знаки — как раньше', () => {
    expect(slugify('Code Review')).toBe('code-review');
    expect(slugify('  --Hello, World!--  ')).toBe('hello-world');
  });

  it('режет длину на 60 символах — id уходит в имя папки', () => {
    const long = 'а'.repeat(80);
    expect(slugify(long)).toHaveLength(60);
  });

  it('имя без букв и цифр даёт пустую строку — вызывающий обязан это учесть', () => {
    expect(slugify('!!! ???')).toBe('');
  });
});
