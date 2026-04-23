import { google } from 'googleapis';
import { config } from '../config';

export function getOAuth2Client() {
  const auth = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
  return auth;
}
