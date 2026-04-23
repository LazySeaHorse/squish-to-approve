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
exports.extractAndValidateZip = extractAndValidateZip;
const adm_zip_1 = __importDefault(require("adm-zip"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const MAX_IMAGES = 10;
function extractAndValidateZip(zipPath, destDir) {
    const zip = new adm_zip_1.default(zipPath);
    const entries = zip
        .getEntries()
        .filter(e => !e.isDirectory && !e.entryName.includes('/') && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()));
    if (entries.length === 0) {
        return { kind: 'empty', message: 'The zip is empty.' };
    }
    if (entries.length > MAX_IMAGES) {
        return { kind: 'too_many', message: `${entries.length} images found; max is ${MAX_IMAGES}.` };
    }
    // Validate naming: must match /^\d+\.(jpg|jpeg|png)$/i
    const nameRe = /^0*(\d+)\.(jpg|jpeg|png)$/i;
    const numbered = [];
    for (const entry of entries) {
        const m = entry.name.match(nameRe);
        if (!m) {
            return {
                kind: 'wrong_naming',
                message: `"${entry.name}" doesn't match the expected naming (1.jpg, 2.png, ...).`,
            };
        }
        numbered.push({ n: parseInt(m[1], 10), name: entry.name });
    }
    // Must have consecutive numbers 1..N
    numbered.sort((a, b) => a.n - b.n);
    for (let i = 0; i < numbered.length; i++) {
        if (numbered[i].n !== i + 1) {
            return {
                kind: 'missing_numbers',
                message: `Expected slide ${i + 1} but found slide ${numbered[i].n}.`,
            };
        }
    }
    // Extract
    if (!fs.existsSync(destDir))
        fs.mkdirSync(destDir, { recursive: true });
    zip.extractAllTo(destDir, true);
    const files = numbered.map(({ name }) => path.join(destDir, name));
    return { files };
}
//# sourceMappingURL=zip.js.map