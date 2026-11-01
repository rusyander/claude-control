import type { RowTone } from '../../model/rowText';
import type { SignalItem } from '../../model/signalView';

export interface SignalLineProps {
  signal: SignalItem;
  /** Цвет заголовка — тон строки ленты по серьёзности. */
  tone: RowTone;
  /** Панель сигналов ставит значок серьёзности перед заголовком; лента — нет (у неё цвет). */
  withSeverity?: boolean;
}
