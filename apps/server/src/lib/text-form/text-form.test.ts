import { describe, it, expect } from 'vitest';
import {
  applyTextForm,
  blockToEol,
  detectEol,
  detectTextForm,
  hasBom,
  stripBom,
} from './text-form.ts';

/**
 * Форма чужого файла (BOM + переводы строк). Ф9/Ф10: панель правит рабочие
 * конфиги пользователя, у которого они вполне могут быть в CRLF и с BOM
 * (Блокнот, PowerShell, git c autocrlf). Здесь проверяется само определение
 * формы; её применение к записи — в тестах safe-io и провайдер-разделов.
 */
describe('detectEol', () => {
  it('файл без CRLF — стиль LF', () => {
    expect(detectEol('a\nb\nc')).toBe('\n');
    expect(detectEol('')).toBe('\n');
  });

  it('файл целиком в CRLF — стиль CRLF', () => {
    expect(detectEol('a\r\nb\r\nc')).toBe('\r\n');
  });

  it('смешанный файл приводится к преобладающему стилю', () => {
    expect(detectEol('a\r\nb\r\nc\nd')).toBe('\r\n');
    expect(detectEol('a\r\nb\nc\nd\ne')).toBe('\n');
  });
});

describe('BOM', () => {
  it('распознаётся и снимается, содержимое не меняется', () => {
    const raw = '﻿{"a":1}';
    expect(hasBom(raw)).toBe(true);
    expect(stripBom(raw)).toBe('{"a":1}');
    // Без BOM строка возвращается той же самой.
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
  });

  it('снятый BOM делает JSON и разбор снова возможными', () => {
    expect(() => JSON.parse('﻿{"a":1}')).toThrow();
    expect(JSON.parse(stripBom('﻿{"a":1}'))).toEqual({ a: 1 });
  });
});

describe('applyTextForm', () => {
  it('CRLF-форма: любые окончания строк приводятся к CRLF, BOM возвращается', () => {
    const out = applyTextForm('раз\nдва\r\nтри', { bom: true, eol: '\r\n' });
    expect(out).toBe('﻿раз\r\nдва\r\nтри');
  });

  it('LF-форма: CRLF из <textarea> нормализуется, BOM не добавляется', () => {
    const out = applyTextForm('раз\r\nдва\r\n', { bom: false, eol: '\n' });
    expect(out).toBe('раз\nдва\n');
    expect(hasBom(out)).toBe(false);
  });

  it('форма исходника определяется и применяется без изменения содержимого', () => {
    const original = '﻿key = 1\r\nother = 2\r\n';
    const form = detectTextForm(original);
    expect(form).toMatchObject({ bom: true, eol: '\r\n' });
    expect(applyTextForm(stripBom(original), form)).toBe(original);
  });
});

describe('blockToEol', () => {
  it('сгенерированный LF-блок переводится в CRLF без смешения', () => {
    const block = blockToEol('[a]\nb = 1\n', '\r\n');
    expect(block).toBe('[a]\r\nb = 1\r\n');
    expect(block.includes('\n\n')).toBe(false);
  });
});
