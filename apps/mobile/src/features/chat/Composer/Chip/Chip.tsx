import { Pressable, Text } from 'react-native';
import { styles } from '../Composer.styles';

export function Chip({
  label,
  on,
  onPress,
  disabled,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: Boolean(disabled), selected: on }}
      style={[styles.chip, on && styles.chipOn, disabled && styles.chipOff]}
    >
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
