import { StyleSheet } from 'react-native';
import { colors, space } from '../../../../shared/config/theme';

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: space.md,
    gap: space.sm,
  },
  tool: { color: colors.warning },
  failed: { color: colors.danger },
  grow: { flex: 1 },
  queue: { gap: space.xs },
});
