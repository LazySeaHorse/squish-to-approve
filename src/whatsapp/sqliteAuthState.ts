import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';

export interface SqliteAuthState {
  state: AuthenticationState;
  saveCreds: () => void;
}

export function useSqliteAuthState(dbPath: string): SqliteAuthState {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS auth_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const get = db.prepare<[string], { value: string }>('SELECT value FROM auth_state WHERE key = ?');
  const set = db.prepare('INSERT OR REPLACE INTO auth_state (key, value) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM auth_state WHERE key = ?');

  function readData(key: string): unknown {
    const row = get.get(key);
    if (!row) return null;
    return JSON.parse(row.value, BufferJSON.reviver);
  }

  function writeData(key: string, data: unknown): void {
    set.run(key, JSON.stringify(data, BufferJSON.replacer));
  }

  function removeData(key: string): void {
    del.run(key);
  }

  const fixKey = (k: string) => k.replace(/\//g, '__').replace(/:/g, '-');

  const creds = (readData('creds.json') as ReturnType<typeof initAuthCreds> | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = readData(fixKey(`${type}-${id}.json`)) as SignalDataTypeMap[T];
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as { [k: string]: unknown }) as unknown as SignalDataTypeMap[T];
            }
            data[id] = value;
          }
          return data;
        },
        set(data: Partial<Record<keyof SignalDataTypeMap, { [id: string]: unknown }>>) {
          for (const category in data) {
            const cat = data[category as keyof SignalDataTypeMap];
            if (!cat) continue;
            for (const id in cat) {
              const value = cat[id];
              const key = fixKey(`${category}-${id}.json`);
              if (value) {
                writeData(key, value);
              } else {
                removeData(key);
              }
            }
          }
        },
      },
    },
    saveCreds() {
      writeData('creds.json', creds);
    },
  };
}
