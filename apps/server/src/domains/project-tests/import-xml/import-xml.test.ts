import { describe, it, expect } from 'vitest';
import {
  decodeXml,
  findElement,
  findElements,
  parseAttributes,
  textContent,
} from './import-xml.ts';

/**
 * Чтение XML для импорта. Проверяется ровно то, обо что спотыкается разбор
 * чужих отчётов: сущности всех трёх видов, кавычки внутри атрибутов,
 * одноимённая вложенность и обрезанный файл.
 */
describe('чтение XML', () => {
  it('разбирает сущности: именованные, десятичные и шестнадцатеричные', () => {
    expect(decodeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      'a & b <c> "d" \'e\'',
    );
    expect(decodeXml('&#1063;&#x430;&#x442;')).toBe('Чат');
    // Неизвестная сущность остаётся как есть: выдумывать за автора нечего.
    expect(decodeXml('&nosuch; &amp;')).toBe('&nosuch; &');
  });

  it('атрибуты читаются в любых кавычках, и `>` внутри значения не обрывает тег', () => {
    const [element] = findElements(
      '<testcase name="a > b" classname=\'c\' time="0.5"/>',
      'testcase',
    );

    expect(element?.attributes).toEqual({ name: 'a > b', classname: 'c', time: '0.5' });
    expect(parseAttributes('x="1" y = "2"')).toEqual({ x: '1', y: '2' });
  });

  it('самозакрывающийся элемент даёт пустое тело, а не проглатывает соседей', () => {
    const found = findElements('<row><c r="A1"/><c r="B1"><v>7</v></c></row>', 'c');

    expect(found).toHaveLength(2);
    expect(found[0]?.body).toBe('');
    expect(textContent(found[1]?.body ?? '')).toBe('7');
  });

  it('одноимённая вложенность не обрывается на первом закрывающем теге', () => {
    const xml =
      '<testsuite name="внешняя"><testsuite name="внутренняя"><t/></testsuite>хвост</testsuite>';
    const found = findElements(xml, 'testsuite');

    expect(found.map((item) => item.attributes.name)).toEqual(['внешняя', 'внутренняя']);
    expect(found[0]?.body).toContain('хвост');
  });

  it('обрезанный файл отдаёт то, что успело прочитаться', () => {
    const found = findElements('<testcase name="оборван">тело без конца', 'testcase');

    expect(found).toHaveLength(1);
    expect(found[0]?.body).toBe('тело без конца');
  });

  it('имя тега сравнивается целиком: <c> — это не <col>', () => {
    const found = findElements('<col min="1"/><c r="A1"><v>1</v></c>', 'c');

    expect(found).toHaveLength(1);
    expect(found[0]?.attributes.r).toBe('A1');
  });

  it('текст элемента: теги выброшены, CDATA раскрыта, комментарии убраны', () => {
    expect(textContent('<b>жирный</b> и <![CDATA[<сырой>]]><!-- заметка -->')).toBe(
      'жирный и <сырой>',
    );
  });

  it('findElement отдаёт первый элемент или ничего', () => {
    expect(findElement('<a x="1"/><a x="2"/>', 'a')?.attributes.x).toBe('1');
    expect(findElement('<a/>', 'b')).toBeUndefined();
  });
});
