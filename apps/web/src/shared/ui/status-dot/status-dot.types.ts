export interface StatusDotProps {
  /** Тон дизайн-системы. Не задан — точка не рисуется. */
  tone?: 'success' | 'neutral' | 'warning' | 'danger';
  /** Пульсация — для активной работы. */
  pulse?: boolean;
  /** Подпись для скринридера (иначе точка скрыта от него). */
  label?: string;
}
