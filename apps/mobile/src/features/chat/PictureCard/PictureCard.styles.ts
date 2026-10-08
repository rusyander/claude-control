import { StyleSheet } from 'react-native';
import { colors, radius, space, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    padding: space.sm,
    gap: space.xs,
  },
  title: { color: colors.textDim, fontSize: font.small, fontWeight: '600' },
  frame: { width: '100%', maxHeight: 360, borderRadius: radius.sm, overflow: 'hidden' },
  broken: { color: colors.textFaint, fontSize: font.small, fontStyle: 'italic' },
});
