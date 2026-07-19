import type { IconName } from '@shared/ui/icon';

/** Оттенок узла берётся из палитры темы — своих цветов у диаграмм нет. */
export type DiagramTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface FlowNode {
  id: string;
  /** Короткая подпись узла: что это за шаг. */
  label: string;
  /** Уточнение под подписью — путь к файлу, событие, кто это делает. */
  caption?: string;
  tone?: DiagramTone;
  icon?: IconName;
  /** Моноширинный шрифт подписи: для путей, имён файлов и ключей конфига. */
  isMono?: boolean;
}

export interface FlowDiagramProps {
  nodes: FlowNode[];
  /** Подписи на стрелках между узлами: на одну меньше, чем узлов. */
  edgeLabels?: string[];
  /** Доступное описание схемы целиком — читается скринридером вместо картинки. */
  ariaLabel: string;
  className?: string;
}

export interface LadderStep {
  id: string;
  label: string;
  caption?: string;
  tone?: DiagramTone;
}

export interface PriorityLadderProps {
  /** Ступени от самой сильной к самой слабой — порядок и есть смысл схемы. */
  steps: LadderStep[];
  /** Подпись у верхней ступени, например «побеждает». */
  topLabel?: string;
  /** Подпись у нижней ступени, например «уступает». */
  bottomLabel?: string;
  ariaLabel: string;
  className?: string;
}
