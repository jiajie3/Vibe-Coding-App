import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { processCapture } from '../services/photos.ts';
import { useSession } from '../state/session.ts';

export default function CameraScreen({ navigation, route }: { navigation: any; route: any }) {
  const fieldId: string | null = route.params?.fieldId ?? null;
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const session = useSession();

  const forField = session.photos.filter((p) => p.field_id === fieldId);
  const takenForField = forField.length;
  const recent = forField.slice(-6);

  const capture = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // exif: true keeps the GPS tags. Normally you strip these for privacy —
      // here they are part of the evidence chain.
      const photo = await cameraRef.current?.takePictureAsync({ quality: 1, exif: true });
      if (photo?.uri) await processCapture(photo.uri, { fieldId });
    } catch (e) {
      // Without this a failure became an unhandled rejection: the photo silently
      // never appeared and the screen looked frozen.
      Alert.alert('Could not save photo', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  if (!permission) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.centre}>
        <Text style={styles.permTitle}>Camera access needed</Text>
        <Text style={styles.permBody}>
          Photographs are the evidence attached to this inspection, and they have
          to be taken here — there is no way to add one from your album.
        </Text>
        <Pressable style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Grant access</Text>
        </Pressable>
        {/* Without this the permission screen was a dead end — denying camera
            access trapped the inspector with no way back to the checklist. */}
        <Pressable style={styles.permAlt} onPress={() => navigation.goBack()}>
          <Text style={styles.permAltText}>Back to checklist</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.screen}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      <SafeAreaView style={styles.overlay} edges={['top', 'bottom']}>
        <View style={styles.topBar}>
          <Text style={styles.count}>
            {takenForField} {takenForField === 1 ? 'photo' : 'photos'}
          </Text>
        </View>

        <View style={styles.bottomBar}>
          {/* Thumbnails of what has landed, so taking a photo has visible
              consequences rather than the screen appearing to do nothing. */}
          {recent.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.strip}
            >
              {recent.map((p) => (
                <Image key={p.id} source={{ uri: p.uri }} style={styles.stripThumb} />
              ))}
            </ScrollView>
          )}

          {session.last_position?.chainage_m != null && (
            <Text style={styles.chainage}>
              chainage {session.last_position.chainage_m.toFixed(0)} m
            </Text>
          )}
          {/* A full-screen modal has no swipe-to-dismiss, so Done is the only
              way out. It used to sit at the top of the overlay, where the
              status bar covered it — safe-area insets report 0 inside a modal
              presentation, so nothing pushed it clear of the clock and wifi
              icon. Putting it beside the shutter makes it both reachable by
              thumb and immune to inset reporting. */}
          <View style={styles.shutterRow}>
            {/* Balances the Done pill on the right, so the shutter stays under
                the thumb rather than sliding to the middle of the screen. */}
            <View style={styles.sideBtn} />

            <Pressable
              style={[styles.shutter, busy && styles.shutterBusy]}
              onPress={capture}
              disabled={busy}
            >
              {busy ? <ActivityIndicator color="#0F172A" /> : <View style={styles.shutterInner} />}
            </Pressable>

            <Pressable style={styles.sideBtn} onPress={() => navigation.goBack()} hitSlop={16}>
              <View style={styles.donePill}>
                <Text style={styles.doneText}>{takenForField > 0 ? 'Done' : 'Cancel'}</Text>
              </View>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  permTitle: { fontSize: 20, fontWeight: '700', color: '#0F172A' },
  permBody: { fontSize: 14, color: '#475569', textAlign: 'center' },
  permBtn: {
    marginTop: 8,
    backgroundColor: '#0F172A',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
  },
  permBtnText: { color: '#fff', fontWeight: '700' },
  permAlt: { paddingVertical: 10 },
  permAltText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },

  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    // Clears the status bar even where the modal reports a zero top inset.
    paddingTop: 52,
  },
  donePill: {
    backgroundColor: '#fff',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  doneText: { color: '#0F172A', fontSize: 13, fontWeight: '700' },
  count: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },

  bottomBar: { alignItems: 'center', paddingBottom: 20, gap: 10 },
  strip: { gap: 8, paddingHorizontal: 16 },
  stripThumb: {
    width: 54,
    height: 54,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  chainage: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  shutterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 34,
  },
  sideBtn: { width: 78, alignItems: 'center', gap: 2 },
  shutter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterBusy: { opacity: 0.6 },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
});
