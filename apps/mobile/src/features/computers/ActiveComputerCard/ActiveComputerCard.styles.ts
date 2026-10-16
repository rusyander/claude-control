import { StyleSheet } from 'react-native';
import { colors, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  grow: { flex: 1 },
  badge: {
    width: 44,
    height: 44,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeOn: { backgroundColor: colors.successDim },
  badgeOff: { backgroundColor: colors.dangerDim },
  online: { color: colors.success, fontSize: font.small + 1, fontWeight: '600' },
  offline: { color: colors.danger, fontSize: font.small + 1, fontWeight: '600' },
});
