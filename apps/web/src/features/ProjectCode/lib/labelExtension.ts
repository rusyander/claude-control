import { EditorView } from 'codemirror';

/** Имя поля правки — атрибутом на самом редактируемом узле, где его ищет скринридер. */
export function labelExtension(ariaLabel: string | undefined) {
  return ariaLabel ? EditorView.contentAttributes.of({ 'aria-label': ariaLabel }) : [];
}
