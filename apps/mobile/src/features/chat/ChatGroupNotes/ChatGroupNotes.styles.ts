import { StyleSheet } from 'react-native';
import { space, colors, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: { gap: space.xs },
  line: { color: colors.textDim, fontSize: font.small },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
    borderRadius: 6,
    padding: space.sm,
    gap: space.sm,
  },
  entry: { gap: 2 },
  title: { color: colors.text, fontSize: font.small, fontWeight: '700' },
  text: { color: colors.text, fontSize: font.small },
  dismiss: { alignSelf: 'flex-end', paddingVertical: space.xs, paddingHorizontal: space.sm },
  dismissText: { color: colors.accent, fontSize: font.small, fontWeight: '600' },
});
