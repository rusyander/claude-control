import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '../Icon/Icon';
import { colors } from '../../config/theme';
import { styles } from './ListRow.styles';

/**
 * Строка списка внутри карточки: заголовок, подпись и шеврон, если строка ведёт
 * дальше. Вся строка — цель нажатия, а не одно слово «Открыть» справа: пальцем
 * по узкой надписи промахиваются.
 */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  divided,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  divided?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, divided && styles.divided, pressed && styles.pressed]}
    >
      {leading}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {onPress && !trailing ? (
        <Icon ios="chevron.right" android="chevron_right" size={18} color={colors.textFaint} />
      ) : null}
    </Pressable>
  );
}
