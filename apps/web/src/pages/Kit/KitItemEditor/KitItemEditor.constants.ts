export const VIEWS = ['text', 'global', 'diff'] as const;

export const VIEW_LABEL: Record<(typeof VIEWS)[number], string> = {
  text: 'kit.editor.viewText',
  global: 'kit.editor.viewGlobal',
  diff: 'kit.editor.viewDiff',
};
