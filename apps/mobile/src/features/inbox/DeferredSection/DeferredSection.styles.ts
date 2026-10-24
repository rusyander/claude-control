import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  section: { gap: space.sm },
  head: { gap: space.xs },
  title: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  hint: { color: colors.textDim, fontSize: font.small, lineHeight: 17 },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    borderRadius: 10,
    padding: space.md,
    gap: space.sm,
  },
  meta: { color: colors.textDim, fontSize: font.small },
  summary: { color: colors.text },
  detail: { color: colors.textDim, fontSize: font.small },
  reason: { color: colors.textDim, fontSize: font.small, lineHeight: 17 },
  expired: { color: colors.warning, fontSize: font.small },
  actions: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1 },
  failed: { color: colors.danger, fontSize: font.small },
});
