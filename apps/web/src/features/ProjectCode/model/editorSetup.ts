import { EditorView } from 'codemirror';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { Prec, type Extension } from '@codemirror/state';

/**
 * Настройка редактора, общая для всех открытых файлов: тема и подсветка
 * синтаксиса.
 *
 * Цвета заданы переменными CSS, а не константами в коде, и это осознанно: тема
 * панели переключается атрибутом `data-theme` на `<html>`, и редактор со своей
 * палитрой на JS пришлось бы пересоздавать при каждом переключении — с потерей
 * позиции курсора, выделения и истории отмен. С переменными он просто
 * перекрашивается вместе со всей страницей. Сами значения живут в
 * `ProjectCode.module.scss` рядом с остальными стилями окна.
 */

/** Тема: рамок и фона у самого редактора нет — их рисует окно вокруг. */
export const editorTheme: Extension = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--color-fg)',
    fontSize: 'var(--font-size-sm)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
    overflow: 'auto',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface-sunken)',
    color: 'var(--color-fg-subtle)',
    border: 'none',
    borderRight: '1px solid var(--color-border)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--color-surface-sunken)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--color-surface-sunken)',
    color: 'var(--color-fg)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-accent-subtle)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-surface-raised)',
    border: '1px solid var(--color-border)',
    color: 'var(--color-fg-muted)',
  },
});

/** Подсветка синтаксиса теми же переменными — см. пояснение выше. */
export const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--code-comment)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--code-number)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--code-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--code-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-property)' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: 'var(--code-punctuation)' },
  { tag: [tags.tagName], color: 'var(--code-keyword)' },
  { tag: tags.invalid, color: 'var(--color-danger)' },
  { tag: tags.heading, color: 'var(--code-keyword)', fontWeight: 'bold' },
  { tag: tags.link, color: 'var(--code-string)', textDecoration: 'underline' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
]);

/**
 * Тема и подсветка одним расширением.
 *
 * Приоритет поднят намеренно: `basicSetup` несёт собственную палитру, и без
 * этого она перебивала бы нашу — редактор жил бы своими цветами, не замечая
 * переключения темы панели.
 */
export const syntaxTheme: Extension = Prec.high([editorTheme, syntaxHighlighting(highlightStyle)]);
