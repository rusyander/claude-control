export interface SelectOption {
  value: string;
  label: string;
  /** Вариант виден, но выбрать его нельзя; причину пишут в подписи. */
  disabled?: boolean;
}

export interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  hint?: string;
  /** Весь выбор недоступен; причину пишет экран рядом (подпись или `hint`). */
  disabled?: boolean;
}
