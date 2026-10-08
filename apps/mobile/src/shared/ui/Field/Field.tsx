import { TextInput, type StyleProp, type TextStyle } from 'react-native';
import { colors } from '../../config/theme';
import { styles } from './Field.styles';

export function Field({
  value,
  onChangeText,
  placeholder,
  multiline,
  autoCapitalize = 'none',
  secure,
  style,
}: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  autoCapitalize?: 'none' | 'sentences';
  secure?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.textFaint}
      multiline={multiline}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      secureTextEntry={secure}
      style={[styles.field, multiline && styles.fieldMultiline, style]}
    />
  );
}
