import { StyleSheet } from 'react-native';
import { colors, font, space } from '../../config/theme';

export const styles = StyleSheet.create({
  empty: {
    paddingVertical: space.xl * 2,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  icon: {
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  title: { color: colors.text, fontSize: font.title, fontWeight: '600', textAlign: 'center' },
  emptyText: { textAlign: 'center', fontSize: font.body, lineHeight: 20, maxWidth: 320 },
});
