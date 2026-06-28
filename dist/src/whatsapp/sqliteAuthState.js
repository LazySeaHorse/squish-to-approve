"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.useSqliteAuthState = useSqliteAuthState;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const baileys_1 = require("@whiskeysockets/baileys");
function useSqliteAuthState(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const db = new better_sqlite3_1.default(dbPath);
    db.exec(`CREATE TABLE IF NOT EXISTS auth_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
    const get = db.prepare('SELECT value FROM auth_state WHERE key = ?');
    const set = db.prepare('INSERT OR REPLACE INTO auth_state (key, value) VALUES (?, ?)');
    const del = db.prepare('DELETE FROM auth_state WHERE key = ?');
    function readData(key) {
        const row = get.get(key);
        if (!row)
            return null;
        return JSON.parse(row.value, baileys_1.BufferJSON.reviver);
    }
    function writeData(key, data) {
        set.run(key, JSON.stringify(data, baileys_1.BufferJSON.replacer));
    }
    function removeData(key) {
        del.run(key);
    }
    const fixKey = (k) => k.replace(/\//g, '__').replace(/:/g, '-');
    const creds = readData('creds.json') ?? (0, baileys_1.initAuthCreds)();
    return {
        state: {
            creds,
            keys: {
                get(type, ids) {
                    const data = {};
                    for (const id of ids) {
                        let value = readData(fixKey(`${type}-${id}.json`));
                        if (type === 'app-state-sync-key' && value) {
                            value = baileys_1.proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set(data) {
                    for (const category in data) {
                        const cat = data[category];
                        if (!cat)
                            continue;
                        for (const id in cat) {
                            const value = cat[id];
                            const key = fixKey(`${category}-${id}.json`);
                            if (value) {
                                writeData(key, value);
                            }
                            else {
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
//# sourceMappingURL=sqliteAuthState.js.map