import { EditorView, GutterMarker, gutter } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { NoteAnchor } from '../../lib/diffNotes.types';
import type { NotesGutterOptions } from './notesGutter.types';

/**
 * Метка в поле заметок: «+» у строки без заметки (видна под мышью и у строки с
 * курсором — ряд плюсов на каждой строке был бы шумом) и точка у строки, к
 * которой заметка уже написана.
 */
class NoteMarker extends GutterMarker {
  constructor(
    readonly line: number,
    readonly hasNote: boolean,
    readonly label: string,
  ) {
    super();
  }

  override eq(other: NoteMarker): boolean {
    return other.line === this.line && other.hasNote === this.hasNote && other.label === this.label;
  }

  override toDOM(): Node {
    const mark = document.createElement('span');
    mark.className = 'cm-diff-note-marker';
    // Распорка поля (строка 0) задаёт только ширину — номера и признака у неё нет.
    if (this.line > 0) {
      mark.dataset.noteLine = String(this.line);
      mark.dataset.hasNote = String(this.hasNote);
    }
    mark.title = this.label;
    mark.textContent = this.hasNote ? '●' : '+';
    return mark;
  }
}

// Цвета — переменные темы панели: редактор перекрашивается вместе со страницей,
// как и остальная его палитра (см. ProjectCodeEditor.module.scss).
const theme = EditorView.theme({
  '.cm-diff-notes-gutter .cm-gutterElement': {
    cursor: 'pointer',
    padding: '0 2px',
  },
  '.cm-diff-note-marker': {
    display: 'inline-block',
    width: '16px',
    lineHeight: '16px',
    textAlign: 'center',
    borderRadius: '4px',
    color: 'var(--color-accent)',
    fontWeight: '600',
    opacity: '0',
  },
  '.cm-diff-notes-gutter .cm-gutterElement:hover .cm-diff-note-marker, .cm-diff-notes-gutter .cm-activeLineGutter .cm-diff-note-marker':
    {
      opacity: '1',
      background: 'var(--color-accent-subtle)',
    },
  '.cm-diff-note-marker[data-has-note="true"]': {
    opacity: '1',
  },
});

/**
 * Поле «+ заметка» слева от текста: клик по строке открывает черновик заметки к
 * ней. Номер и текст берутся из документа редактора в момент клика — ровно то,
 * что человек видит на экране, а не строка файла на диске.
 */
export function notesGutter({ lines, label, onPick }: NotesGutterOptions): Extension {
  const anchorAt = (view: EditorView, from: number): Omit<NoteAnchor, 'path'> => {
    const line = view.state.doc.lineAt(from);
    return { line: line.number, text: line.text };
  };
  return [
    theme,
    gutter({
      class: 'cm-diff-notes-gutter',
      lineMarker: (view, block) => {
        const { line } = anchorAt(view, block.from);
        return new NoteMarker(line, lines.has(line), label);
      },
      initialSpacer: () => new NoteMarker(0, true, label),
      domEventHandlers: {
        mousedown: (view, block) => {
          onPick(anchorAt(view, block.from));
          return true;
        },
      },
    }),
  ];
}
