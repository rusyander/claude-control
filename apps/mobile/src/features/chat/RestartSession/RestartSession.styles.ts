import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  link: { alignSelf: 'center', paddingVertical: space.xs },
  linkText: { color: colors.accent, fontSize: font.small },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: space.md,
    gap: space.sm,
  },
  hint: { color: colors.textDim, fontSize: font.small, lineHeight: 18 },
  error: { color: colors.danger, fontSize: font.small },
  grow: { flex: 1 },
});
