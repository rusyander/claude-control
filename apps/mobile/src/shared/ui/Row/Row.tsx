import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { space } from '../../config/theme';
import { styles } from './Row.styles';

export function Row({
  children,
  gap = space.sm,
  style,
}: {
  children: ReactNode;
  gap?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.row, { gap }, style]}>{children}</View>;
}
