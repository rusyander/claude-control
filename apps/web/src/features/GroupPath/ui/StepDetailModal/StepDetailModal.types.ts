import type { ReactNode } from 'react';
import type { KnobView, LocalizedLine, PathStep } from '@agentdeck/contracts';
import type { RowText } from '../../model/describe.types';
import type { PathRow } from '../../model/pathRows.types';
import type { RowBilingual } from '../../model/rowBilingual';
import type { StepSource } from '../../model/stepSource.types';
import { useTranslation } from 'react-i18next';

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

export type Translate = ReturnType<typeof useTranslation>['t'];
