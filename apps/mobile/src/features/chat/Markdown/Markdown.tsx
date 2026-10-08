import { Text, View } from 'react-native';
import { splitBlocks } from '../splitBlocks';
import { styles } from './Markdown.styles';
import { inline } from '../inline';

export function Markdown({ children }: { children: string }) {
  const blocks = splitBlocks(children);
  if (blocks.length === 0) return null;

  return (
    <View style={styles.root}>
      {blocks.map((block, blockIndex) =>
        block.kind === 'code' ? (
          <View key={`b${blockIndex}`} style={styles.code}>
            {block.lang ? <Text style={styles.codeLang}>{block.lang}</Text> : null}
            <Text style={styles.codeText}>{block.content.replace(/\n+$/, '')}</Text>
          </View>
        ) : (
          <Text key={`b${blockIndex}`} style={styles.text}>
            {inline(block.content.replace(/\n{3,}/g, '\n\n').trim(), `b${blockIndex}`)}
          </Text>
        ),
      )}
    </View>
  );
}
