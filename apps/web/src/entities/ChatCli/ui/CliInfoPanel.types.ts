export interface CliInfoPanelProps {
  /** Спрашивать сервер мимо кеша — карточка ошибки, где версия могла только что смениться. */
  refresh?: boolean;
  /** Показывать кнопку «Обновить CLI». */
  withUpdate?: boolean;
}
