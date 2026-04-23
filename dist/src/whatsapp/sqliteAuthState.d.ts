import type { AuthenticationState } from '@whiskeysockets/baileys';
export interface SqliteAuthState {
    state: AuthenticationState;
    saveCreds: () => void;
}
export declare function useSqliteAuthState(dbPath: string): SqliteAuthState;
//# sourceMappingURL=sqliteAuthState.d.ts.map