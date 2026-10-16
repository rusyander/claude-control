import { Text, View } from 'react-native';
import { tints } from '../../../shared/config/theme';
import { styles } from './ProjectTile.styles';

/** Оттенок по имени: тот же у проекта на каждом экране и при каждом запуске. */
function tintOf(name: string): (typeof tints)[number] {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return tints[hash % tints.length] ?? tints[0];
}

/** Плитка с первой буквой проекта — опознавательный знак строки в длинном списке. */
export function ProjectTile({ name, size = 44 }: { name: string; size?: number }) {
  const tint = tintOf(name);
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.3),
          backgroundColor: tint.bg,
        },
      ]}
    >
      <Text style={[styles.letter, { color: tint.fg, fontSize: Math.round(size * 0.42) }]}>
        {letter}
      </Text>
    </View>
  );
}
