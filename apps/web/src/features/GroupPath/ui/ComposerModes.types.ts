export type ComposerMode = 'describe' | 'pick' | 'hook';

export interface ComposerModesProps {
  mode: ComposerMode;
  /** Префикс id вкладок и панели. */
  idBase: string;
  onChange: (mode: ComposerMode) => void;
}
