import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  state: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  list: { gap: space.sm },
  device: { gap: space.xs },
  name: { color: colors.text, fontSize: font.body },
  revoked: { color: colors.textDim, fontSize: font.body, textDecorationLine: 'line-through' },
  confirm: {
    gap: space.sm,
    padding: space.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningDim,
  },
  confirmTitle: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  warn: { color: colors.warning },
  danger: { color: colors.danger },
});
