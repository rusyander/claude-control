import { Pressable, Text, View } from 'react-native';
import { styles } from './Chips.styles';

/**
 * Ряд взаимоисключающих значений: тип кейса, важность, отбор по статусу.
 *
 * Не выпадающий список: значений три-пять, все короткие, и на телефоне ряд
 * читается и нажимается за один взгляд, тогда как список стоит двух тапов и
 * прячет варианты до первого из них.
 */
export function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.chips}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="button"
          onPress={() => onChange(option.value)}
          style={[styles.chip, option.value === value && styles.chipOn]}
        >
          <Text style={styles.chipText}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
