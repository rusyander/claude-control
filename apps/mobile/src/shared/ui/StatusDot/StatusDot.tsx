import { View } from 'react-native';
import { colors } from '../../config/theme';
import { styles } from './StatusDot.styles';

/** Точка статуса прогона — те же смыслы, что в панели. */
export function StatusDot({ status }: { status: string }) {
  const color =
    status === 'running'
      ? colors.running
      : status === 'waiting'
        ? colors.waiting
        : status === 'error'
          ? colors.danger
          : status === 'done'
            ? colors.success
            : colors.textFaint;
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}
