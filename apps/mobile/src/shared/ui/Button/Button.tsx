import { ActivityIndicator, Pressable, Text, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '../../config/theme';
import { styles } from './Button.styles';

export function Button({
  title,
  onPress,
  tone = 'default',
  disabled,
  busy,
  style,
}: {
  title: string;
  onPress: () => void;
  tone?: 'default' | 'accent' | 'danger' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const toneStyle =
    tone === 'accent'
      ? styles.buttonAccent
      : tone === 'danger'
        ? styles.buttonDanger
        : tone === 'ghost'
          ? styles.buttonGhost
          : styles.buttonDefault;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        toneStyle,
        (disabled || busy) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.text} size="small" />
      ) : (
        <Text style={styles.buttonText}>{title}</Text>
      )}
    </Pressable>
  );
}
