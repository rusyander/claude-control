import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  option: { gap: space.xs },
  name: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  confirm: {
    gap: space.sm,
    padding: space.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerDim,
  },
  confirmTitle: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  warn: { color: colors.warning },
  danger: { color: colors.danger },
});
