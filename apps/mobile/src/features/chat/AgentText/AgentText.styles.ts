import { StyleSheet } from 'react-native';
import { space, colors, font } from '../../../shared/config/theme';

export const styles = StyleSheet.create({
  root: { gap: space.sm },
  note: { color: colors.accent, fontSize: font.small, lineHeight: 18 },
});
