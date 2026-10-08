import { Pressable, Text } from 'react-native';
import { styles } from '../Composer.styles';

export function Toggle({
  label,
  on,
  onPress,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, on && styles.toggleOn]}>
      <Text style={[styles.toggleText, on && styles.toggleTextOn]}>
        {on ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}
