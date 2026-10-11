import { Pressable, ScrollView, Text, View } from 'react-native';
import { styles } from './Chips.styles';

/**
 * Ряд взаимоисключающих значений: тип кейса, важность, отбор по статусу.
 *
 * Не выпадающий список: значений три-пять, все короткие, и на телефоне ряд
 * читается и нажимается за один взгляд, тогда как список стоит двух тапов и
 * прячет варианты до первого из них.
 *
 * `scroll` — одна строка с прокруткой вбок: пять периодов аналитики, перенесённые
 * на вторую строку, рвали ряд «Сегодня … Всё время» посередине.
 */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  scroll,
}: {
  options: { value: T; label: string }[];
  value: T | undefined;
  onChange: (value: T) => void;
  scroll?: boolean;
}) {
  const chips = options.map((option) => {
    const selected = option.value === value;
    return (
      <Pressable
        key={option.value}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={() => onChange(option.value)}
        style={({ pressed }) => [styles.chip, selected && styles.chipOn, pressed && styles.pressed]}
      >
        <Text style={[styles.chipText, selected && styles.chipTextOn]}>{option.label}</Text>
      </Pressable>
    );
  });
  if (!scroll) return <View style={styles.chips}>{chips}</View>;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.stripContent}
      style={styles.strip}
    >
      {chips}
    </ScrollView>
  );
}
