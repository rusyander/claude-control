import { StyleSheet } from 'react-native';
import { colors, radius, space } from '../../shared/config/theme';

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  danger: { borderColor: colors.danger },
  name: { color: colors.warning },
  dangerText: { color: colors.danger },
  field: { gap: space.xs },
  label: { color: colors.textDim },
  long: { maxHeight: 200 },
  grow: { flex: 1 },
});
