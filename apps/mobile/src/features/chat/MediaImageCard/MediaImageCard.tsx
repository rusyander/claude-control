import { Image, Pressable, Text, View } from 'react-native';
import type { MediaImage } from '@agentdeck/contracts';
import { apiUrl } from '../../../shared/api/client';
import { useT } from '../../../shared/config/i18n';
import { Mono, Row } from '../../../shared/ui';
import { space } from '../../../shared/config/theme';
import { imageCardLines, mediaImagePath } from '../../../entities/media/api';
import { authHeaders } from '../../../shared/api/authHeaders';
import { styles } from './MediaImageCard.styles';

/**
 * Картинка, которую панель нарисовала сама (Т9), — карточкой над полем ввода,
 * аналог правого столбца панели.
 *
 * В переписку она не попадает намеренно: расшифровка — файл Claude Code, и
 * панель не пишет в него ни строки, иначе она подделывала бы чужую историю.
 * Файл лежит у панели; байты берутся тем же адресом, что у панели, с токеном в
 * заголовке — никогда в строке адреса.
 */
export function MediaImageCard({ image, onClose }: { image: MediaImage; onClose: () => void }) {
  const t = useT();
  const words = t.composer.mode;
  const ratio = image.width && image.height ? image.width / image.height : 1;

  return (
    <View style={styles.card}>
      <Row gap={space.sm} style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>
          {words.image}
        </Text>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t.common.close}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </Row>
      <Image
        source={{ uri: apiUrl(mediaImagePath(image.id)), headers: authHeaders() }}
        style={[styles.image, { aspectRatio: ratio }]}
        resizeMode="contain"
        accessibilityLabel={image.prompt}
      />
      {imageCardLines(image, words).map((line) => (
        <Mono key={line}>{line}</Mono>
      ))}
      <Mono style={styles.note}>{words.card.note}</Mono>
    </View>
  );
}
