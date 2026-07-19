export interface ExplainBoxProps {
  title: string;
  text: string;
  /** Сворачиваемый блок: справка не должна мешать, когда уже всё понятно. */
  defaultOpen?: boolean;
}
