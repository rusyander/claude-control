import type { E2eRunOutcome } from '../e2eRunOutcome';
import type { TextStyle } from 'react-native';
import { styles } from './TestE2eCard.styles';

/** Цвет итога: красный — упавшие тесты или сбой запуска, жёлтый — «проверьте». */
export const TONE_STYLE: Record<E2eRunOutcome['tone'], TextStyle | undefined> = {
  plain: undefined,
  success: styles.success,
  danger: styles.danger,
  warning: styles.warning,
};
