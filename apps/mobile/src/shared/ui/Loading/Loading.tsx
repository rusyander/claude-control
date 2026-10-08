import { ActivityIndicator, View } from 'react-native';
import { colors } from '../../config/theme';
import { styles } from './Loading.styles';

export function Loading() {
  return (
    <View style={styles.empty}>
      <ActivityIndicator color={colors.accent} />
    </View>
  );
}
