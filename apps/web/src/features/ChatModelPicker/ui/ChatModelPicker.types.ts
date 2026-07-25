import type { ModelInfo } from '@claude-control/contracts';

export interface ChatModelPickerProps {
  /** Оверрайд модели для этого чата ('' = брать из настроек). */
  model: string;
  /** Оверрайд глубины для этого чата ('' = брать из настроек). */
  effort: string;
  /** Модель по умолчанию из настроек — чтобы подписать пункт «по умолчанию». */
  defaultModel: string;
  /** Глубина по умолчанию из настроек. */
  defaultEffort: string;
  /**
   * Модели каталога провайдера: их предлагают в дополнение к алиасам, чтобы в
   * чате можно было взять конкретное поколение, а не только «последний opus».
   * Пусто — остаются одни алиасы (каталог не скачался или не поддерживается).
   */
  models?: ModelInfo[];
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
}
