import { StyleSheet } from 'react-native';
import { space, colors, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  box: { gap: space.xs },
  row: { flexDirection: 'row', gap: space.xs, alignItems: 'flex-start' },
  label: { color: colors.textDim, fontSize: font.small },
  text: { color: colors.text, fontSize: font.small, flex: 1 },
  link: { color: colors.accent, textDecorationLine: 'underline' },
});
