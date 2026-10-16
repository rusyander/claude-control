import { StyleSheet } from 'react-native';
import { colors } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
  },
  running: { backgroundColor: colors.accentDim },
  waiting: { backgroundColor: colors.warningDim },
  dot: { width: 6, height: 6, borderRadius: 999 },
  text: { fontSize: 11, fontWeight: '700' },
});
