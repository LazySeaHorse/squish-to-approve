"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const ts = () => new Date().toISOString();
exports.logger = {
    info: (msg, ...args) => console.log(`[${ts()}] INFO  ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[${ts()}] WARN  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[${ts()}] ERROR ${msg}`, ...args),
};
//# sourceMappingURL=logger.js.map