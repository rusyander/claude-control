import { Pressable, Switch, Text, View } from 'react-native';
import { colors } from '../../config/theme';
import { styles } from './SwitchRow.styles';

/**
 * Настройка «вкл/выкл» строкой: подпись слева, системный переключатель справа.
 * Прежняя галочка в тексте («✓ Панель шлёт уведомления») не читалась как
 * нажимаемая, а выключенное состояние было просто пустым местом.
 */
export function SwitchRow({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      onPress={() => onChange(!value)}
      disabled={disabled}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor={colors.text}
        // Строка уже объявлена переключателем — второй элемент для чтеца лишний.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </Pressable>
  );
}
