export interface NumberSettingRowProps {
  label: string;
  hint?: string;
  /** Сохранённое значение настройки. */
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Класс поля ввода — ширину задаёт страница. */
  inputClassName?: string;
  /** Класс пояснения — у части строк оно ограничено по ширине. */
  hintClassName?: string;
  onChange: (value: number) => void;
}
