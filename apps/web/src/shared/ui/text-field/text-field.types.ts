export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Пояснение под полем: что сюда писать и как это повлияет. */
  hint?: string;
  /** Многострочное поле — для текста правил и тела скилла. */
  multiline?: boolean;
  rows?: number;
  /** Моноширинный шрифт — для команд и путей. */
  isMono?: boolean;
  error?: string;
  autoFocus?: boolean;
  /** Заблокировать ввод: например, имя папки у уже созданного скилла. */
  disabled?: boolean;
  /**
   * Показать значение, но не дать его править — в отличие от `disabled` поле
   * остаётся в обходе с клавиатуры, а текст можно выделить и скопировать.
   * Для того, что пишет не человек: результат прогона, вычисленный путь.
   */
  readOnly?: boolean;
  /** Тип однострочного поля: `password` скрывает ввод (парольная фраза). */
  type?: 'text' | 'password';
}
