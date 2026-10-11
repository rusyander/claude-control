import { Pressable, Text, View } from 'react-native';
import { styles } from './Segmented.styles';

/**
 * Переключатель видов одного экрана: «Чаты | Вопросы», «Разговор | История».
 * Отличие от {@link Chips}: варианты делят строку поровну и читаются как
 * вкладки, а не как фильтр, — выбран всегда ровно один, и он виден заливкой.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; a11y?: string; badge?: number }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.track} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value;
        const badge = option.badge ?? 0;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={option.a11y ?? option.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, selected && styles.segmentOn]}
          >
            <Text style={[styles.text, selected && styles.textOn]} numberOfLines={1}>
              {option.label}
            </Text>
            {badge > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
