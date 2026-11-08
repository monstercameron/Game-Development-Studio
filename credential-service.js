import { createLogger } from './runtime/app-log.js';
import { credentialErrorFields, credentialStore } from './runtime/credentials.js';

const log = createLogger('credentials');
const json = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
};
// Names the first failed guard so a rejection can be logged without echoing Host or Origin.
function forbiddenReason(req, host) {
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '')) {
    return 'not_loopback';
  }
  if (req.headers.origin !== `http://${host}`) {
    return 'bad_origin';
  }
  if (req.headers['x-forge-request'] !== 'credentials') {
    return 'bad_header';
  }
  return 'bad_method';
}
export function credentialService({ store = credentialStore } = {}) {
  function attach(server) {
    server.middlewares.use('/api/credentials', async (req, res) => {
      const host = req.headers.host;
      if (
        !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host || '') ||
        req.headers.origin !== `http://${host}` ||
        req.headers['x-forge-request'] !== 'credentials' ||
        req.method !== 'POST'
      ) {
        log.warn('credentials.request.rejected', {
          reason: forbiddenReason(req, host),
          route: '/api/credentials',
        });
        return json(res, 403, { error: 'Local studio requests only.' });
      }
      let raw = '',
        input;
      try {
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > 10000) {
            log.warn('credentials.request.rejected', {
              reason: 'too_large',
              route: '/api/credentials',
            });
            return json(res, 413, { error: 'Credential request is too large.' });
          }
        }
        input = JSON.parse(raw);
      } catch (error) {
        // JSON.parse messages can quote the request body, so only the class is logged.
        log.warn('credentials.request.rejected', {
          reason: 'bad_request',
          route: '/api/credentials',
          ...credentialErrorFields(error),
        });
        return json(res, 400, { error: 'Invalid request.' });
      }
      const route = new URL(req.url, 'http://127.0.0.1').pathname;
      try {
        if (route === '/status') {
          return json(res, 200, { credentials: store.status() });
        }
        if (route === '/save') {
          if (
            !['openai', 'huggingface'].includes(input.provider) ||
            typeof input.secret !== 'string' ||
            input.secret.length < 1 ||
            input.secret.length > 4096 ||
            !/^[\x21-\x7e]+$/.test(input.secret)
          ) {
            log.warn('credentials.request.rejected', {
              reason: ['openai', 'huggingface'].includes(input.provider)
                ? 'invalid_secret'
                : 'unknown_provider',
              route: '/api/credentials',
            });
            return json(res, 400, {
              error: 'Enter a valid API key without spaces or line breaks.',
            });
          }
          await store.set(input.provider, input.secret);
          return json(res, 200, { saved: true });
        }
        if (route === '/remove') {
          if (!['openai', 'huggingface'].includes(input.provider)) {
            log.warn('credentials.request.rejected', {
              reason: 'unknown_provider',
              route: '/api/credentials',
            });
            return json(res, 400, { error: 'Choose a supported provider.' });
          }
          store.remove(input.provider);
          return json(res, 200, { removed: true });
        }
        return json(res, 404, { error: 'Not found.' });
      } catch (error) {
        log.error('credentials.request.failed', {
          route: '/api/credentials',
          ...credentialErrorFields(error),
        });
        return json(res, 500, {
          error:
            'Could not access the encrypted credential store. Check that the studio is running under the Windows account that saved the key.',
        });
      }
    });
  }
  return { name: 'forge-credentials', configureServer: attach, configurePreviewServer: attach };
}
