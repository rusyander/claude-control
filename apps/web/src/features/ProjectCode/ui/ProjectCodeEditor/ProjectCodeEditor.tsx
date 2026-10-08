import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import { syntaxTheme } from '../../model/editorSetup';
import { languageFor } from '../../model/languages';
import type { ProjectCodeEditorProps } from './ProjectCodeEditor.types';
import styles from './ProjectCodeEditor.module.scss';
import { LOADED } from './ProjectCodeEditor.constants';
import { labelExtension } from '../../lib/labelExtension';

export function ProjectCodeEditor({
  path,
  content,
  baseline,
  mtimeMs,
  isEditable,
  showDiff,
  onChange,
  onSave,
  ariaLabel,
  autoFocus = false,
}: ProjectCodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const language = useRef(new Compartment()).current;
  const merge = useRef(new Compartment()).current;
  const writable = useRef(new Compartment()).current;
  const label = useRef(new Compartment()).current;

  // Колбэки читаются из ref: иначе каждый ререндер родителя пересобирал бы
  // состояние редактора — вместе с курсором и историей отмен.
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  const mergeExtension =
    showDiff && baseline !== undefined
      ? unifiedMergeView({
          original: baseline,
          // Кнопок «принять/отклонить» нет намеренно: их подписи приходят из
          // библиотеки и не переводятся, а решение «вернуть как было» человек
          // принимает правкой текста — она здесь и так разрешена.
          mergeControls: false,
          highlightChanges: true,
          syntaxHighlightDeletions: true,
          gutter: true,
        })
      : [];

  // Создание редактора — ровно один раз на открытие окна.
  useEffect(() => {
    if (!host.current) return undefined;

    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          syntaxTheme,
          basicSetup,
          language.of([]),
          merge.of([]),
          writable.of([]),
          label.of(labelExtension(ariaLabel)),
          EditorView.lineWrapping,
          // Приоритет выше стандартного набора: иначе Ctrl+S перехватил бы
          // браузер и предложил сохранить страницу.
          Prec.highest(
            keymap.of([
              {
                key: 'Mod-s',
                preventDefault: true,
                run: () => {
                  handlers.current.onSave();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.some((transaction) => transaction.annotation(LOADED))) return;
            handlers.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = instance;
    if (autoFocus) instance.focus();

    return () => {
      instance.destroy();
      view.current = null;
    };
    // Отсеки лежат в ref и не меняются — список зависимостей пуст осознанно.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Новый файл или новая его версия на диске — заменяем текст целиком.
  // Заменяем ИМЕННО по этим двум признакам, а не по расхождению текста: пока
  // человек печатает, текст в редакторе и должен расходиться с серверным.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;

    if (instance.state.doc.toString() !== content) {
      instance.dispatch({
        changes: { from: 0, to: instance.state.doc.length, insert: content },
        annotations: LOADED.of(true),
        // Курсор в начало: это другой файл, прежняя позиция к нему отношения
        // не имеет и указывала бы в случайное место.
        selection: { anchor: 0 },
      });
    }
    instance.dispatch({ effects: merge.reconfigure(mergeExtension) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, mtimeMs]);

  // Переключение диффа состояние не пересоздаёт: набранное и курсор остаются
  // на месте, меняется только показ.
  useEffect(() => {
    view.current?.dispatch({ effects: merge.reconfigure(mergeExtension) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDiff, baseline]);

  useEffect(() => {
    view.current?.dispatch({
      effects: writable.reconfigure([
        EditorState.readOnly.of(!isEditable),
        EditorView.editable.of(isEditable),
      ]),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditable]);

  useEffect(() => {
    view.current?.dispatch({ effects: label.reconfigure(labelExtension(ariaLabel)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ariaLabel]);

  // Грамматика приезжает отдельным куском и может опоздать: пока её нет, файл
  // читается как обычный текст. Ответ на устаревший путь отбрасываем — иначе
  // быстрое переключение файлов оставило бы чужую подсветку.
  useEffect(() => {
    let isCurrent = true;

    void languageFor(path).then((support) => {
      if (isCurrent) view.current?.dispatch({ effects: language.reconfigure(support ?? []) });
    });

    return () => {
      isCurrent = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div ref={host} className={styles.editor} data-testid="project-code-editor" />;
}
