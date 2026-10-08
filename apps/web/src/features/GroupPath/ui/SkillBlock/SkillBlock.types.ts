import type { ReactNode } from 'react';
import type { RowType } from '../../model/rowWords.types';

export interface SkillBlockProps {
  title: string;
  type: RowType;
  /** Сколько строк в блоке — видно и у свёрнутого. */
  count: number;
  /** Состояние чисел скилла словами: «читаются…», «нет», «3 числа». */
  knobsText: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
}
