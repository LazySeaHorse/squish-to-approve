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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFolder = createFolder;
exports.copyTemplate = copyTemplate;
exports.uploadImage = uploadImage;
exports.renameFile = renameFile;
exports.deleteFile = deleteFile;
exports.shareDoc = shareDoc;
const googleapis_1 = require("googleapis");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const auth_1 = require("./auth");
const config_1 = require("../config");
function getDrive() {
    return googleapis_1.google.drive({ version: 'v3', auth: (0, auth_1.getOAuth2Client)() });
}
async function createFolder(parentFolderId, folderName) {
    const drive = getDrive();
    const res = await drive.files.create({
        requestBody: {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentFolderId],
        },
        fields: 'id',
    });
    return res.data.id;
}
async function copyTemplate(templateId, title, campaignFolderId) {
    const drive = getDrive();
    const truncated = title.slice(0, 80);
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const name = `Approval - ${truncated} - ${now}`;
    const res = await drive.files.copy({
        fileId: templateId,
        requestBody: {
            name,
            parents: [campaignFolderId],
        },
    });
    return res.data.id;
}
async function uploadImage(filePath, campaignFolderId) {
    const drive = getDrive();
    const name = path.basename(filePath);
    const mimeType = filePath.match(/\.png$/i) ? 'image/png' : 'image/jpeg';
    const res = await drive.files.create({
        requestBody: {
            name,
            parents: [campaignFolderId],
        },
        media: {
            mimeType,
            body: fs.createReadStream(filePath),
        },
        fields: 'id',
    });
    const driveFileId = res.data.id;
    await drive.permissions.create({
        fileId: driveFileId,
        requestBody: { role: 'reader', type: 'anyone' },
    });
    return {
        driveFileId,
        publicUrl: `https://drive.google.com/uc?id=${driveFileId}`,
    };
}
async function renameFile(fileId, newName) {
    const drive = getDrive();
    await drive.files.update({
        fileId,
        requestBody: { name: newName },
    });
}
async function deleteFile(fileId) {
    const drive = getDrive();
    await drive.files.delete({ fileId });
}
async function shareDoc(docId) {
    const drive = getDrive();
    await drive.permissions.create({
        fileId: docId,
        requestBody: { role: config_1.config.OUTPUT_DOC_PERMISSION, type: 'anyone' },
    });
}
//# sourceMappingURL=drive.js.map