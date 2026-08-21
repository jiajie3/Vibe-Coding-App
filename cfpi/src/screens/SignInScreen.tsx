import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { uuidv7 } from '../core/uuid.ts';
import { signIn } from '../services/auth.ts';
import { getConfig, setConfig } from '../services/config.ts';
import { syncJobs } from '../data/jobs.ts';

/**
 * Sign-in, with the server address on the same screen.
 *
 * Deliberately together: on a fresh handset both are unset, and an inspector who
 * signs in successfully against no server has achieved nothing. One screen, one
 * outcome — jobs on the phone.
 */
export default function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [server, setServer] = useState(getConfig().server_url);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = server.trim().replace(/\/+$/, '');
      if (!url) throw new Error('Enter the FRCDE server address');
      setConfig({ server_url: url });

      // A stable per-install id, so FRCDE can revoke one lost handset without
      // disabling the person who was carrying it.
      const cfg = getConfig();
      let deviceId = cfg.device_id;
      if (!deviceId) {
        deviceId = uuidv7();
        setConfig({ device_id: deviceId });
      }

      await signIn(username.trim(), password, deviceId);
      await syncJobs();
      onSignedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.logo}>CFPI</Text>
            <Text style={styles.tagline}>Coastal &amp; Flood Protection Inspection</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>FRCDE server</Text>
            <TextInput
              style={styles.input}
              value={server}
              onChangeText={setServer}
              placeholder="http://192.168.0.3:4000"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />

            <Text style={[styles.label, { marginTop: 6 }]}>Username</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="inspector"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
            />

            <Text style={[styles.label, { marginTop: 6 }]}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor="#94A3B8"
              secureTextEntry
              autoComplete="current-password"
              onSubmitEditing={submit}
              returnKeyType="go"
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <Pressable
              style={[styles.btn, busy && styles.btnBusy]}
              onPress={submit}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnText}>Sign in</Text>
              )}
            </Pressable>
          </View>

          <Text style={styles.hint}>
            Accounts — inspector / inspector, siti / siti
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0F172A' },
  body: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 18 },
  brand: { alignItems: 'center', gap: 2 },
  logo: { fontSize: 40, fontWeight: '800', color: '#fff', letterSpacing: 2 },
  tagline: {
    fontSize: 13,
    color: '#94A3B8',
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0.2,
  },

  card: { backgroundColor: '#fff', borderRadius: 16, padding: 18, gap: 6 },
  label: { fontSize: 12, fontWeight: '800', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6 },
  input: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: '#0F172A',
  },
  error: { fontSize: 13, color: '#B91C1C', fontWeight: '600', marginTop: 4 },
  btn: {
    backgroundColor: '#16A34A',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  btnBusy: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  hint: { fontSize: 12, color: '#64748B', textAlign: 'center' },
});
