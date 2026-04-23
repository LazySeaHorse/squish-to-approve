import { connect } from './whatsapp/client';
import { logger } from './logger';

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

logger.info('Starting approve-to-squish bot…');
connect().catch(err => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
