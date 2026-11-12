import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

export function sameSecret(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}
export function authenticator(config, fetcher = fetch) {
  return async function authenticate(header) {
    const token = /^Bearer ([^\s]+)$/i.exec(header || '')?.[1];
    if (!token || token.length > 12000) throw new AppError(401, 'UNAUTHORIZED', 'Sign in to use the assistant.');
    if (config.AUTH_MODE === 'test-key') {
      if (!sameSecret(token, config.TEST_API_KEY)) throw new AppError(401, 'UNAUTHORIZED', 'Invalid test key.');
      return { id: 'render-test-user', mode: 'test-key' };
    }
    let response;
    try {
      response = await fetcher(`${config.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`, {
        headers: { apikey: config.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000), redirect: 'error',
      });
    } catch { throw new AppError(503, 'AUTH_UNAVAILABLE', 'Sign-in verification is temporarily unavailable.'); }
    if (!response.ok) throw new AppError(401, 'UNAUTHORIZED', 'Your sign-in has expired. Sign in again.');
    const user = await response.json();
    if (typeof user.id !== 'string' || !user.id) throw new AppError(401, 'UNAUTHORIZED', 'Invalid sign-in.');
    return { id: user.id, mode: 'supabase' };
  };
}
