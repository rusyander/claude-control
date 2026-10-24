export interface SettingToggleRowProps {
  label: string;
  hint?: string;
  checked: boolean;
  /** Рычаг, который сейчас ничего не решает (его зависимость выключена). */
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}
