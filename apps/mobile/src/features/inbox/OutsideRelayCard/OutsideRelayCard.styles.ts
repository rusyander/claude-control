import { StyleSheet } from 'react-native';
import { colors, radius, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  command: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  failed: { color: colors.danger },
});
