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
/**
 * One-time script to obtain a Google OAuth2 refresh token.
 * Run: npm run auth:google
 * Then paste the printed refresh token into your .env as GOOGLE_REFRESH_TOKEN.
 */
const googleapis_1 = require("googleapis");
const http = __importStar(require("http"));
const url = __importStar(require("url"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
    process.exit(1);
}
const oauth2Client = new googleapis_1.google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const SCOPES = [
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive',
];
const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // force refresh token issuance
});
console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. After authorising, the refresh token will be printed here.\n');
// Start a local server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/oauth2callback'))
        return;
    const qs = new url.URL(req.url, 'http://localhost:3000').searchParams;
    const code = qs.get('code');
    if (!code) {
        res.end('No code received. Try again.');
        return;
    }
    try {
        const { tokens } = await oauth2Client.getToken(code);
        res.end('Auth complete! You can close this tab.');
        server.close();
        console.log('\n✅ Refresh token obtained:\n');
        console.log(tokens.refresh_token);
        console.log('\nAdd this to your .env:\n');
        console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    }
    catch (err) {
        res.end('Error exchanging code. Check the terminal.');
        console.error(err);
        server.close();
    }
});
server.listen(3000, () => {
    console.log('Waiting for OAuth callback on http://localhost:3000 …');
});
//# sourceMappingURL=auth-google.js.map