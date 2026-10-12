export interface ProjectEnvironmentModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Каталог проекта: Compose, база и API ищутся в нём. */
  projectPath: string;
  /**
   * Положить просьбу агенту в поле чата (окно при этом закрывается): «Сверить
   * контракт с кодом» во вкладке «API», «Разобрать в чате» во вкладке «Логи».
   * Не передан — кнопок нет.
   */
  onAskAgent?: (text: string) => void;
  /** Куда отдать фокус после закрытия (после «Спросить агента» — в поле чата); см. `ModalProps`. */
  focusOnClose?: () => HTMLElement | null | undefined;
}
