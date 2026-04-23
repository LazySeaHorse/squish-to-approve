"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOAuth2Client = getOAuth2Client;
const googleapis_1 = require("googleapis");
const config_1 = require("../config");
function getOAuth2Client() {
    const auth = new googleapis_1.google.auth.OAuth2(config_1.config.GOOGLE_CLIENT_ID, config_1.config.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: config_1.config.GOOGLE_REFRESH_TOKEN });
    return auth;
}
//# sourceMappingURL=auth.js.map