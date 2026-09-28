import type { KnobView } from '@agentdeck/contracts';

export interface KnobSelectProps {
  knob: KnobView;
  /** Название шага — для доступного имени: одинаковых «Кругов ревью» в окне может быть два. */
  stepTitle: string;
  isSaving: boolean;
  /** `null` — вернуть «Авто», число — закрепить. */
  onChange: (value: number | null) => void;
}
