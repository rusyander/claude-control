import { StyleSheet } from 'react-native';
import { colors, space, font, radius } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  card: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.sm,
    gap: space.xs,
  },
  head: { justifyContent: 'space-between', alignItems: 'center' },
  title: { color: colors.text, fontSize: font.small, fontWeight: '600', flex: 1 },
  close: { color: colors.textDim, fontSize: 18, paddingHorizontal: space.xs },
  image: { width: '100%', maxHeight: 240, borderRadius: radius.sm, backgroundColor: colors.bg },
  note: { color: colors.textFaint },
});
