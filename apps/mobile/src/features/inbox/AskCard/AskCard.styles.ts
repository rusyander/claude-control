import { StyleSheet } from 'react-native';
import { colors, space, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: 10,
    padding: space.md,
    gap: space.sm,
  },
  grow: { flex: 1 },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  link: { color: colors.accent, fontSize: font.small },
  done: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  doneMark: { color: colors.success, fontSize: font.body, fontWeight: '700' },
  doneText: { color: colors.textDim, fontSize: font.small, flex: 1 },
  current: { gap: space.sm },
  step: { color: colors.textFaint },
  hint: { color: colors.textDim, fontSize: font.small, lineHeight: 17 },
  footer: { gap: space.sm },
  failed: { color: colors.danger, fontSize: font.small },
});
