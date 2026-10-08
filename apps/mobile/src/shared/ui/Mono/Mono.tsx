import type { ReactNode } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { styles } from './Mono.styles';

export function Mono({
  children,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  return (
    <Text style={[styles.mono, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}
