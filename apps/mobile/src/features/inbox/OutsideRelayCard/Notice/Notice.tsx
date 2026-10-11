import { Text, View } from 'react-native';
import { Icon } from '../../../../shared/ui';
import { colors } from '../../../../shared/config/theme';
import { styles } from './Notice.styles';

/** Плашка состояния хука: значок и цвет говорят раньше текста. */
export function Notice({ tone, text }: { tone: 'ok' | 'warning'; text: string }) {
  const ok = tone === 'ok';
  return (
    <View style={[styles.notice, ok ? styles.ok : styles.warning]}>
      <Icon
        ios={ok ? 'checkmark.circle.fill' : 'exclamationmark.triangle.fill'}
        android={ok ? 'check_circle' : 'warning'}
        size={18}
        color={ok ? colors.success : colors.warning}
      />
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}
