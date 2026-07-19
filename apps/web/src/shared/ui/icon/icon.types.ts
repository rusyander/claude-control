import type { IconName } from './icon.constants';

export interface IconProps {
  name: IconName;
  size?: number;
  /** Цвет наследуется от текста, если не задан явно. */
  color?: string;
  className?: string;
  /**
   * Подпись для скринридера. Без неё иконка считается декоративной
   * и скрывается через aria-hidden — так у неё не появляется «пустого» имени.
   */
  label?: string;
}
