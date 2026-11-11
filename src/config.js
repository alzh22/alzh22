import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env file — use process env / defaults */
}

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  password: env.APP_PASSWORD || '',
  dataProvider: (env.DATA_PROVIDER || 'demo').toLowerCase(),
  polygonKey: env.POLYGON_API_KEY || '',
  broker: (env.BROKER || 'demo').toLowerCase(),
  alpacaKey: env.ALPACA_KEY_ID || '',
  alpacaSecret: env.ALPACA_SECRET_KEY || '',
  alpacaLive: env.ALPACA_LIVE === 'true',
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  publicDir: path.join(ROOT, 'public'),
};
