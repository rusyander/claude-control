import type { InstructionFilesView } from '@agentdeck/contracts';

export interface InstructionFilesCardProps {
  view: InstructionFilesView;
  /**
   * Имя, выбранное человеком, пока файла нет. `undefined` — выбор не предложен
   * (файл уже есть либо у режима один вариант).
   */
  chosenName?: string;
  onChooseName?: (fileName: string) => void;
  className?: string;
}
