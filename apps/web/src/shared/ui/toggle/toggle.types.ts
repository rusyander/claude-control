export interface ToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Обязателен: переключатель без подписи не читается скринридером. */
  'aria-label': string;
  size?: 'sm' | 'md';
}
