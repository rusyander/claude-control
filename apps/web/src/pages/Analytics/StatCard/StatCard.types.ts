export interface StatCardProps {
  label: string;
  value: string;
  hint?: string;
  /** Дополнительная строка под значением: расшифровка или доля. */
  detail?: string;
}
