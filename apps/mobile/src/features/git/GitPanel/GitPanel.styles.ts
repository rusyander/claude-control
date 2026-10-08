import { StyleSheet } from 'react-native';
import { space, colors, font, radius } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  wrap: { flexWrap: 'wrap' },
  files: { gap: space.xs, paddingVertical: space.xs },
  mark: { color: colors.accent, fontSize: font.small, fontFamily: font.mono, width: 14 },
  failed: { color: colors.danger },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 180,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  chipText: { color: colors.textDim, fontSize: font.small },
});
