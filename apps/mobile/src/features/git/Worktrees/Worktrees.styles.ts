import { StyleSheet } from 'react-native';
import { space, colors, font, radius } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  item: {
    gap: space.xs,
    paddingVertical: space.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  badge: {
    fontSize: font.small,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  ready: { color: colors.textDim, backgroundColor: colors.accentDim },
  notReady: { color: colors.danger, borderWidth: 1, borderColor: colors.danger },
  path: { color: colors.textDim, fontSize: font.small },
  gap: { color: colors.textDim, fontSize: font.small },
  failed: { color: colors.danger },
});
