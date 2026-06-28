"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const zod_1 = require("zod");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const schema = zod_1.z.object({
    ALLOWED_JIDS: zod_1.z.string().min(1).transform(s => s.split(',').map(j => j.trim())),
    BAILEYS_DB_PATH: zod_1.z.string().default('./data/baileys.db'),
    GOOGLE_CLIENT_ID: zod_1.z.string().min(1),
    GOOGLE_CLIENT_SECRET: zod_1.z.string().min(1),
    GOOGLE_REFRESH_TOKEN: zod_1.z.string().min(1),
    TEMPLATE_ID_IG: zod_1.z.string().min(1),
    TEMPLATE_ID_IG_FB: zod_1.z.string().min(1),
    OUTPUT_FOLDER_ID: zod_1.z.string().min(1),
    TRIGGER_URL: zod_1.z.string().min(1),
    OUTPUT_DOC_PERMISSION: zod_1.z.enum(['reader', 'commenter', 'writer']).default('reader'),
    PAIRING_TIMEOUT_MS: zod_1.z.coerce.number().default(120000),
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
    console.error('❌ Invalid configuration:\n', parsed.error.format());
    process.exit(1);
}
exports.config = parsed.data;
//# sourceMappingURL=config.js.map