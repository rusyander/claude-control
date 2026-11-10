export interface SiteOpenButtonProps {
  /** Имя запущенной цели — как в списке запусков. */
  name: string;
  /** Адрес dev-сервера: видно, какой именно сайт откроется. */
  url: string;
  /** Окно сайта уже открыто — кнопка нажата, повторное нажатие закрывает. */
  isOpen: boolean;
  isOpening: boolean;
  onToggle: () => void;
}
