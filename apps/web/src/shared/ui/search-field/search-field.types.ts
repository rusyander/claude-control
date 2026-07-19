export interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Подпись для скринридера: визуально поле подписи не имеет. */
  label: string;
}
