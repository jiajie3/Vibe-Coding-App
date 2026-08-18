import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import KeyboardDone, { keyboardDoneProps } from '../components/KeyboardDone.tsx';
import { syncJobs } from '../data/jobs.ts';
import { getInspector, signOut } from '../services/auth.ts';
import { getConfig, setConfig } from '../services/config.ts';
import {
  clearDead,
  drain,
  items,
  onOutboxChange,
  retryDead,
  stats,
} from '../services/outbox.ts';
import { resetLocalData } from '../services/reset.ts';

type Status =
  | { state: 'idle' }
  | { state: 'working' }
  | { state: 'ok'; message: string }
  | { state: 'fail'; message: string };

export default function SettingsScreen({ navigation }: { navigation: any }) {
  const [url, setUrl] = useState(getConfig().server_url);
  const [status, setStatus] = useState<Status>({ state: 'idle' });
  const [queue, setQueue] = useState(stats());
  const lastConnected = useRef(getConfig().server_url);

  useEffect(() => onOutboxChange(() => setQueue(stats())), []);

  /**
   * Connect and pull jobs in one step.
   *
   * Downloading used to be a separate button, which made it possible to connect
   * successfully and still have an empty job list — the inspector does
   * everything the screen asks and gets no work. Entering an address *is* the
   * request for jobs.
   *
   * There is no separate reachability check either: fetching the jobs proves the
   * server is reachable, and reporting a count of everything in the asset
   * register was actively misleading — the number that matters is how many jobs
   * landed on this phone.
   */
  const connect = useCallback(async (address: string) => {
    const clean = address.trim();
    setConfig({ server_url: clean });
    lastConnected.current = clean;
    setStatus({ state: 'working' });

    const r = await syncJobs();
    setStatus(
      r.ok
        ? {
            state: 'ok',
            message: `Connected — ${r.count} job${r.count === 1 ? '' : 's'} downloaded`,
          }
        : { state: 'fail', message: r.error ?? 'Could not reach the server' },
    );
  }, []);

  // Typing an address and moving on is enough — no second tap required.
  const onBlurAddress = () => {
    const next = url.trim();
    setConfig({ server_url: next });
    if (next && next !== lastConnected.current) void connect(next);
  };

  // Reconnect on open if an address is already saved, so a changed laptop IP
  // surfaces as a visible failure rather than a silently stale job list.
  useEffect(() => {
    const saved = getConfig().server_url;
    if (saved) void connect(saved);
  }, [connect]);

  const dead = items().filter((i) => i.state === 'dead');
  const busy = status.state === 'working';

  const confirmReset = () =>
    Alert.alert(
      'Reset this device?',
      'Deletes cached jobs, saved inspections, queued uploads and photos on this phone. ' +
        'The server address is kept. Anything not yet synced to FRCDE is lost.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            const r = resetLocalData();
            setStatus({
              state: r.failed.length ? 'fail' : 'ok',
              message: r.failed.length
                ? `Reset, but could not clear: ${r.failed.join(', ')}`
                : 'Device reset — reconnect to download jobs again.',
            });
          },
        },
      ],
    );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => navigation.goBack()} hitSlop={12}>
          <Text style={styles.back}>‹ Jobs</Text>
        </Pressable>
        <Text style={styles.title}>Settings</Text>

        <View style={styles.card}>
          <Text style={styles.label}>FRCDE server</Text>
          <Text style={styles.help}>
            The address printed when you start FRCDE. Your phone and the laptop must be
            on the same Wi-Fi.
          </Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            onBlur={onBlurAddress}
            placeholder="http://192.168.0.3:4000"
            placeholderTextColor="#94A3B8"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            {...keyboardDoneProps}
          />
          <Pressable
            style={[styles.btn, styles.btnDark]}
            onPress={() => void connect(url)}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnDarkText}>Connect and download jobs</Text>
            )}
          </Pressable>

          {(status.state === 'ok' || status.state === 'fail') && (
            <Text style={[styles.status, status.state === 'fail' && styles.statusBad]}>
              {status.state === 'ok' ? '✓ ' : '✕ '}
              {status.message}
            </Text>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Sync queue</Text>
          <Text style={styles.help}>
            Everything CFPI sends to FRCDE queues here first, so an inspection completed
            with no signal is never lost. It drains automatically.
          </Text>

          <View style={styles.counts}>
            <View style={styles.count}>
              <Text style={styles.countValue}>{queue.pending}</Text>
              <Text style={styles.countLabel}>waiting</Text>
            </View>
            <View style={styles.count}>
              <Text style={[styles.countValue, queue.dead > 0 && styles.countBad]}>
                {queue.dead}
              </Text>
              <Text style={styles.countLabel}>failed</Text>
            </View>
          </View>

          <Pressable style={[styles.btn, styles.btnDark]} onPress={() => void drain()}>
            <Text style={styles.btnDarkText}>Sync now</Text>
          </Pressable>

          {/* Failed items are never discarded silently — losing a completed
              inspection means someone drives back to the site. */}
          {dead.length > 0 && (
            <View style={styles.deadBox}>
              <Text style={styles.deadTitle}>Needs attention</Text>
              {dead.slice(0, 6).map((i) => (
                <View key={i.id} style={styles.deadRow}>
                  <Text style={styles.deadKind}>{i.kind}</Text>
                  <Text style={styles.deadItem} selectable>
                    {i.last_error ?? 'unknown error'}
                  </Text>
                </View>
              ))}
              <View style={styles.row}>
                <Pressable style={styles.btn} onPress={retryDead}>
                  <Text style={styles.btnText}>Retry all</Text>
                </Pressable>
                <Pressable style={styles.btn} onPress={clearDead}>
                  <Text style={styles.btnText}>Discard</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Kept next to the queue on purpose: this discards anything still
              waiting to reach FRCDE, and that has to be obvious. */}
          <Pressable style={styles.reset} onPress={confirmReset}>
            <Text style={styles.resetText}>Reset this device</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Signed in</Text>
          <Text style={styles.help}>
            {getInspector()?.name ?? 'Session restored'}
            {getInspector()?.depot ? ` · ${getInspector()!.depot} depot` : ''}
          </Text>
          <Pressable
            style={styles.btn}
            onPress={() =>
              Alert.alert(
                'Sign out?',
                queue.pending + queue.dead > 0
                  ? `${queue.pending + queue.dead} item(s) are still waiting to reach FRCDE. They stay on this device and will sync when you sign back in.`
                  : 'You will need your username and password to sign back in.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
                ],
              )
            }
          >
            <Text style={styles.btnText}>Sign out</Text>
          </Pressable>
        </View>
      </ScrollView>

      <KeyboardDone />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F1F5F9' },
  body: { padding: 20, paddingBottom: 40, gap: 14 },
  back: { fontSize: 16, color: '#2563EB', fontWeight: '600' },
  title: { fontSize: 28, fontWeight: '700', color: '#0F172A', letterSpacing: -0.5 },

  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, gap: 10 },
  label: { fontSize: 15, fontWeight: '700', color: '#0F172A' },
  help: { fontSize: 12.5, color: '#64748B', lineHeight: 18 },
  input: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    color: '#0F172A',
  },
  row: { flexDirection: 'row', gap: 8 },
  btn: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
  },
  btnText: { fontSize: 14, fontWeight: '700', color: '#0F172A' },
  btnDark: { backgroundColor: '#0F172A' },
  btnDarkText: { fontSize: 14, fontWeight: '700', color: '#fff' },
  status: { fontSize: 12.5, fontWeight: '600', color: '#15803D' },
  statusBad: { color: '#B91C1C' },

  counts: { flexDirection: 'row', gap: 10 },
  count: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  countValue: { fontSize: 24, fontWeight: '800', color: '#0F172A' },
  countBad: { color: '#DC2626' },
  countLabel: { fontSize: 11, color: '#64748B', fontWeight: '600' },

  deadBox: { backgroundColor: '#FEF2F2', borderRadius: 10, padding: 12, gap: 6 },
  deadTitle: { fontSize: 13, fontWeight: '800', color: '#B91C1C' },
  deadRow: { gap: 1 },
  deadKind: { fontSize: 11, fontWeight: '800', color: '#7F1D1D', textTransform: 'uppercase' },
  deadItem: { fontSize: 12, color: '#991B1B' },

  reset: { paddingVertical: 12, alignItems: 'center' },
  resetText: { fontSize: 13, fontWeight: '700', color: '#DC2626' },
});
