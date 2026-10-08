import { View } from 'react-native';
import { Muted } from '../Muted/Muted';
import { styles } from './Empty.styles';

export function Empty({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <Muted style={styles.emptyText}>{text}</Muted>
    </View>
  );
}
