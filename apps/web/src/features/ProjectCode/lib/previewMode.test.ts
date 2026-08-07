import { describe, it, expect } from 'vitest';
import type { ProjectFileContent } from '@claude-control/contracts';
import { bodyKind, canPreview, defaultTab, hasBothSides } from './previewMode';

/**
 * Выбор стороны файла. Правило одно: показывать только то, что у файла есть.
 * Ошибка здесь стоит пустого экрана — вкладка есть, а показать по ней нечего.
 */
function file(patch: Partial<ProjectFileContent> = {}): ProjectFileContent {
  return {
    path: 'a.ts',
    content: 'const a = 1;\n',
    kind: 'none',
    added: 0,
    removed: 0,
    unmatched: 0,
    isBinary: false,
    sizeBytes: 13,
    mtimeMs: 1,
    tooBig: false,
    isReadOnly: false,
    ...patch,
  };
}

describe('вкладка по умолчанию', () => {
  it('есть показ — открываем показом, любого формата', () => {
    expect(defaultTab(file({ path: 'i.svg', preview: 'svg' }))).toBe('preview');
    expect(defaultTab(file({ path: 'r.md', preview: 'markdown' }))).toBe('preview');
  });

  it('картинка — только показом', () => {
    expect(defaultTab(file({ preview: 'image', isBinary: true, content: '' }))).toBe('preview');
  });

  it('у обычного кода второй стороны нет', () => {
    expect(defaultTab(file())).toBe('code');
    expect(hasBothSides(file())).toBe(false);
  });
});

describe('что рисовать', () => {
  it('переключать есть что только у SVG и разметки', () => {
    expect(hasBothSides(file({ preview: 'svg' }))).toBe(true);
    expect(hasBothSides(file({ preview: 'markdown' }))).toBe(true);
    expect(hasBothSides(file({ preview: 'image', isBinary: true }))).toBe(false);
  });

  it('картинка не показывает редактор, даже если вкладка осталась от прошлого файла', () => {
    expect(bodyKind(file({ preview: 'image', isBinary: true }), 'code')).toBe('placeholder');
    expect(bodyKind(file({ preview: 'image', isBinary: true }), 'preview')).toBe('preview');
  });

  it('слишком большой файл не показуем ничем: причина отказа — вес', () => {
    const heavy = file({ preview: 'image', isBinary: true, tooBig: true });

    expect(canPreview(heavy)).toBe(false);
    expect(bodyKind(heavy, 'preview')).toBe('placeholder');
  });

  it('без файла — объяснение, а не пустой редактор', () => {
    expect(bodyKind(undefined, 'code')).toBe('placeholder');
  });

  it('двоичное без известного формата остаётся отказом', () => {
    expect(bodyKind(file({ isBinary: true, content: '' }), 'preview')).toBe('placeholder');
  });
});
