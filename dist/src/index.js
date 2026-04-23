"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("./whatsapp/client");
const logger_1 = require("./logger");
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error('Unhandled rejection:', reason);
});
logger_1.logger.info('Starting approve-to-squish bot…');
(0, client_1.connect)().catch(err => {
    logger_1.logger.error('Fatal startup error:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map