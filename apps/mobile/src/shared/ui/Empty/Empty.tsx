import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Muted } from '../Muted/Muted';
import { styles } from './Empty.styles';

/**
 * Пустое состояние: значок, что здесь будет, и одна строка — почему пусто или
 * что сделать. Голая строка серым посреди чёрного экрана читалась как «ещё
 * грузится» или «сломалось».
 */
export function Empty({
  text,
  title,
  icon,
  children,
}: {
  text: string;
  title?: string;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <Muted style={styles.emptyText}>{text}</Muted>
      {children}
    </View>
  );
}
