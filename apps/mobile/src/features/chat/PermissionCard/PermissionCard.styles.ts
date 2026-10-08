import { StyleSheet } from 'react-native';
import { colors, radius, space } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.sm,
  },
  tool: { color: colors.warning },
  failed: { color: colors.danger },
  grow: { flex: 1 },
});
