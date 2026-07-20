export interface ChatModelPickerProps {
  /** Оверрайд модели для этого чата ('' = брать из настроек). */
  model: string;
  /** Оверрайд глубины для этого чата ('' = брать из настроек). */
  effort: string;
  /** Модель по умолчанию из настроек — чтобы подписать пункт «по умолчанию». */
  defaultModel: string;
  /** Глубина по умолчанию из настроек. */
  defaultEffort: string;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}
