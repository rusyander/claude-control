import type { ReactNode } from 'react';
import type { KnobView, LocalizedLine, PathStep } from '@agentdeck/contracts';
import type { RowBilingual } from '../model/rowWords';
import type { PathRow } from '../model/pathRows';
import type { StepSource } from '../model/stepSource';
import type { RowText } from '../model/describe';

export interface StepDetailModalProps {
  row: PathRow;
  title: string;
  source: StepSource;
  text: RowText;
  /** Описание на двух языках и оригинал, который прогон читает как есть. */
  bilingual?: RowBilingual;
  /** Где строка лежит на диске; нет — у стадии и скилла плагина. */
  file?: string;
  isKnobSaving: boolean;
  onKnob: (knob: KnobView, value: number | null) => void;
  /** Только у своего шага: открыть его правку. */
  onEdit?: (step: PathStep) => void;
  onClose: () => void;
}

export interface FactProps {
  label: string;
  children: ReactNode;
}

export interface StepTextsProps {
  step: PathStep;
}

export interface SummaryTextsProps {
  summary: LocalizedLine;
}
