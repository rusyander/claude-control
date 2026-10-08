import type { PathLang, PathStepProposal } from '@agentdeck/contracts';

export interface StepProposalEditorProps {
  proposal: PathStepProposal;
  /** Открытая вкладка языка. */
  lang: PathLang;
  /** Сторона, которую правили после последнего перевода; нет — стороны согласованы. */
  edited: PathLang | undefined;
  /** Правлены обе стороны: окно спрашивает, с какой переводить или оставить обе. */
  bothEdited: boolean;
  isTranslating: boolean;
  onLangChange: (lang: PathLang) => void;
  onEdit: (field: 'title' | 'prompt' | 'gate', lang: PathLang, value: string) => void;
  onTranslate: () => void;
  onTranslateFrom: (from: PathLang) => void;
  onKeepBoth: () => void;
}
