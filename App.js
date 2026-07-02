import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { openDatabaseSync } from 'expo-sqlite';
import { SQLiteStorage } from 'expo-sqlite/kv-store';

// DATABASE_VERSION used internally by expo-sqlite's SQLiteStorage migration.
const DATABASE_VERSION = 1;

let dbCounter = 0;
const uniqueName = (prefix) => `${prefix}-${dbCounter++}`;

/**
 * Repro A — DETERMINISTIC (100%).
 *
 * Puts a database into the exact state that an interrupted / raced first-run
 * migration leaves behind: `user_version` bumped to DATABASE_VERSION, but the
 * `storage` table never created. `maybeMigrateDb*` returns early whenever
 * `user_version >= DATABASE_VERSION`, so the table is NEVER recreated and the
 * store is permanently broken — every read/write throws `no such table: storage`.
 */
const reproUnrecoverable = () => {
  const name = uniqueName('kv-broken');

  const raw = openDatabaseSync(name);
  raw.execSync(`PRAGMA user_version = ${DATABASE_VERSION};`); // "already migrated"
  raw.execSync('DROP TABLE IF EXISTS storage;'); // ...but the table is missing
  raw.closeSync();

  const storage = new SQLiteStorage(name);
  try {
    storage.getItemSync('any-key');
    return { ok: false, msg: 'UNEXPECTED: no error — bug not reproduced' };
  } catch (e) {
    return { ok: true, msg: `REPRODUCED -> ${String(e?.message ?? e)}` };
  }
};

/**
 * Repro B — ORGANIC RACE (best-effort, timing dependent, like #33754).
 *
 * `getDbAsync()` acquires `awaitLock`; `getDbSync()` does NOT. On a brand-new DB
 * the two first-run migrations can run concurrently on the same file with no
 * shared lock. This loop fires the async and sync paths against the same fresh
 * store, interleaving them, and reports any errors that surface
 * (`database is locked`, `no such table: storage`, etc.).
 */
const reproRace = async (iterations = 100) => {
  const failures = [];

  for (let i = 0; i < iterations; i++) {
    const storage = new SQLiteStorage(uniqueName('kv-race'));

    // Start async init (acquires the lock, then opens+migrates on later ticks).
    const asyncP = storage
      .getItem('k')
      .then(() => null)
      .catch((e) => `async: ${String(e?.message ?? e)}`);

    // Yield so openDatabaseAsync is in flight, then hit the UNLOCKED sync path
    // while this.db is still null -> a second connection races the migration.
    await Promise.resolve();
    let syncErr = null;
    try {
      storage.getItemSync('k');
    } catch (e) {
      syncErr = `sync: ${String(e?.message ?? e)}`;
    }

    const asyncErr = await asyncP;
    if (syncErr) failures.push({ i, err: syncErr });
    if (asyncErr) failures.push({ i, err: asyncErr });
  }

  return failures;
};

export default function App() {
  const [outputA, setOutputA] = useState('—');
  const [outputB, setOutputB] = useState('—');
  const [running, setRunning] = useState(false);

  const runA = useCallback(() => {
    const res = reproUnrecoverable();
    setOutputA(res.msg);
  }, []);

  const runB = useCallback(async () => {
    setRunning(true);
    setOutputB('running 100 iterations...');
    try {
      const failures = await reproRace(100);
      if (!failures.length) {
        setOutputB('No errors surfaced this run (race is timing dependent — try again).');
      } else {
        const sample = failures
          .slice(0, 5)
          .map((f) => `#${f.i}: ${f.err}`)
          .join('\n');
        setOutputB(`${failures.length}/100 iterations errored:\n${sample}`);
      }
    } finally {
      setRunning(false);
    }
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>expo-sqlite kv-store repro</Text>
        <Text style={styles.subtitle}>getDbSync() has no lock · migration is not self-healing</Text>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>A · Unrecoverable state (deterministic)</Text>
          <Text style={styles.cardBody}>
            DB with user_version=1 but no `storage` table {'->'} kv-store never recreates it.
          </Text>
          <TouchableOpacity style={styles.button} onPress={runA}>
            <Text style={styles.buttonText}>Run A</Text>
          </TouchableOpacity>
          <Text style={styles.output}>{outputA}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>B · Sync/async race (best-effort)</Text>
          <Text style={styles.cardBody}>
            Fires getItem() (async) and getItemSync() concurrently on fresh DBs.
          </Text>
          <TouchableOpacity
            style={[styles.button, running && styles.buttonDisabled]}
            onPress={runB}
            disabled={running}
          >
            <Text style={styles.buttonText}>{running ? 'Running...' : 'Run B'}</Text>
          </TouchableOpacity>
          <Text style={styles.output}>{outputB}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingTop: 72, gap: 16 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 13, color: '#666', marginBottom: 8 },
  card: { borderWidth: 1, borderColor: '#e2e2e2', borderRadius: 12, padding: 16, gap: 8 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  cardBody: { fontSize: 13, color: '#444' },
  button: { backgroundColor: '#000', borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 4 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontWeight: '600' },
  output: { fontFamily: 'Courier', fontSize: 12, color: '#b00020', marginTop: 4 },
});
