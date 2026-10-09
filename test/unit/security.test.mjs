// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SessionStore,
  SlidingWindowCounter,
  canonicalExactOrigin,
  isLoopbackHost,
  randomToken,
  safeEqualText,
  sameOrigin,
  secureHeaders,
} from '../../src/security.mjs';

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
  + "connect-src 'self'; font-src 'self' data:; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; "
  + "worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'";

/**
 * Controllable clock for time-dependent code.
 * @param {number} [start]
 */
function clock(start = 1000000) {
  let current = start;
  return {
    now: () => current,
    advance: (/** @type {number} */ ms) => {
      current += ms;
    },
  };
}

describe('secureHeaders', () => {
  it('sends the exact content security policy and the fixed hardening headers', () => {
    const headers = secureHeaders();
    assert.equal(headers['Content-Security-Policy'], CSP);
    assert.equal(headers['Cache-Control'], 'no-store');
    assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
    assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.equal(headers['Referrer-Policy'], 'no-referrer');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.equal(headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=(), payment=()');
  });

  it('adds Strict-Transport-Security only for https deployments', () => {
    assert.equal('Strict-Transport-Security' in secureHeaders(), false);
    assert.equal(secureHeaders({}, { https: true })['Strict-Transport-Security'], 'max-age=15552000');
  });

  it('lets caller headers override the defaults', () => {
    const headers = secureHeaders({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/plain' });
    assert.equal(headers['Cache-Control'], 'no-cache');
    assert.equal(headers['Content-Type'], 'text/plain');
    assert.equal(headers['X-Frame-Options'], 'DENY');
  });
});

describe('canonicalExactOrigin', () => {
  it('returns the exact origin for canonical spellings', () => {
    assert.equal(canonicalExactOrigin('https://example.com'), 'https://example.com');
    assert.equal(canonicalExactOrigin('http://localhost:4180'), 'http://localhost:4180');
    assert.equal(canonicalExactOrigin('https://[::1]:8443'), 'https://[::1]:8443');
  });

  it('rejects every non-canonical or non-origin value', () => {
    for (const value of [
      '', undefined, null, 'https://example.com/', 'https://example.com/a', 'https://example.com?q=1',
      'https://example.com#x', 'https://u@example.com', 'https://Example.com', 'https://example.com:443',
      'HTTPS://example.com', 'ftp://example.com', 'javascript:alert(1)', 'not a url', 'https://',
    ]) {
      assert.equal(canonicalExactOrigin(value), '', String(value));
    }
  });
});

describe('sameOrigin', () => {
  /** @param {Record<string, string>} headers */
  const req = (headers) => /** @type {any} */ ({ headers });

  it('compares with the configured public origin exactly when one is set', () => {
    const request = req({ origin: 'https://gw.example', host: 'internal:4180' });
    assert.equal(sameOrigin(request, 'https://gw.example'), true);
    assert.equal(sameOrigin(req({ origin: 'https://gw.example', host: 'gw.example' }), 'https://other.example'),
      false);
  });

  it('falls back to the Host header, accepting either scheme', () => {
    assert.equal(sameOrigin(req({ origin: 'http://localhost:4180', host: 'localhost:4180' })), true);
    assert.equal(sameOrigin(req({ origin: 'https://localhost:4180', host: 'localhost:4180' })), true);
    assert.equal(sameOrigin(req({ origin: 'HTTP://LOCALHOST:4180', host: 'localhost:4180' })), true);
    assert.equal(sameOrigin(req({ origin: 'http://evil.example', host: 'localhost:4180' })), false);
  });

  it('rejects requests without an Origin or a Host to compare against', () => {
    assert.equal(sameOrigin(req({ host: 'localhost:4180' })), false);
    assert.equal(sameOrigin(req({ origin: 'null', host: 'localhost:4180' })), false);
    assert.equal(sameOrigin(req({ origin: 'http://localhost:4180' })), false);
    assert.equal(sameOrigin(req({ origin: 'https://gw.example' }), 'https://gw.example'), true);
  });
});

describe('small helpers', () => {
  it('compares secrets in constant time semantics without accepting different lengths', () => {
    assert.equal(safeEqualText('secret-value', 'secret-value'), true);
    assert.equal(safeEqualText('secret-value', 'secret-valuE'), false);
    assert.equal(safeEqualText('short', 'shorter'), false);
    assert.equal(safeEqualText('', ''), true);
  });

  it('generates url-safe random tokens of the requested entropy', () => {
    const token = randomToken();
    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(randomToken(), randomToken());
    assert.equal(randomToken(9).length, 12);
  });

  it('recognises only the three loopback spellings', () => {
    for (const host of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.5', '127.0.0.2', 'localhost.example', '']) {
      assert.equal(isLoopbackHost(host), false, host);
    }
  });
});

describe('SessionStore', () => {
  const secret = 'signing-secret-for-tests';

  it('issues tokens in the v1 format that verify and survive a new store with the same secret', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 60000, now: time.now });
    const token = store.create();
    assert.match(token, /^v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(store.has(token), true);
    assert.equal(new SessionStore({ secret, ttlMs: 60000, now: time.now }).has(token), true);
  });

  it('rejects tokens signed with another secret', () => {
    const time = clock();
    const token = new SessionStore({ secret, ttlMs: 60000, now: time.now }).create();
    assert.equal(new SessionStore({ secret: 'another-secret', ttlMs: 60000, now: time.now }).has(token), false);
  });

  it('rejects any tampering with the payload or the signature', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 60000, now: time.now });
    const [version, issuedAt, random, signature] = store.create().split('.');
    const flipped = signature[0] === 'A' ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    assert.equal(store.has(`${version}.${issuedAt}.${random}.${flipped}`), false);
    assert.equal(store.has(`${version}.${Number(issuedAt) + 1}.${random}.${signature}`), false);
    assert.equal(store.has(`${version}.${issuedAt}.${randomToken(18)}.${signature}`), false);
  });

  it('rejects malformed, oversized and non-string tokens', () => {
    const store = new SessionStore({ secret, ttlMs: 60000, now: clock().now });
    for (const token of ['', 'v1.1.2', 'v2.1.abcdefghijklmnop.x', 'v1.abc.abcdefghijklmnop.' + 'a'.repeat(43),
      'v1.1.abcdefghijklmnop.' + 'a'.repeat(600), 'x'.repeat(600), undefined, null, 42]) {
      assert.equal(store.has(token), false, String(token).slice(0, 20));
    }
  });

  it('expires tokens after the TTL', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 1000, now: time.now });
    const token = store.create();
    time.advance(999);
    assert.equal(store.has(token), true);
    time.advance(1);
    assert.equal(store.has(token), false);
  });

  it('rejects tokens issued in the future relative to the verifying clock', () => {
    const issuer = clock(5000000);
    const token = new SessionStore({ secret, ttlMs: 60000, now: issuer.now }).create();
    assert.equal(new SessionStore({ secret, ttlMs: 60000, now: clock(1000).now }).has(token), false);
  });

  it('revokes a token without affecting others', () => {
    const store = new SessionStore({ secret, ttlMs: 60000, now: clock().now });
    const first = store.create();
    const second = store.create();
    store.revoke(first);
    assert.equal(store.has(first), false);
    assert.equal(store.has(second), true);
    assert.equal(store.revokedCount, 1);
  });

  it('ignores revocation of tokens it did not issue', () => {
    const store = new SessionStore({ secret, ttlMs: 60000, now: clock().now });
    store.revoke('v1.1.abcdefghijklmnop.forged');
    store.revoke(undefined);
    store.revoke(12345);
    assert.equal(store.revokedCount, 0);
  });

  it('bounds the revocation list and forgets revocations once their tokens would have expired', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 1000, now: time.now, maxRevoked: 2 });
    const tokens = [store.create(), store.create(), store.create()];
    for (const token of tokens) store.revoke(token);
    assert.equal(store.revokedCount, 2);

    time.advance(1000);
    store.revoke(store.create());
    assert.equal(store.revokedCount, 1);
  });

  it('validates its constructor arguments', () => {
    assert.throws(() => new SessionStore({ secret: '', ttlMs: 1000 }), TypeError);
    assert.throws(() => new SessionStore({ secret, ttlMs: 0 }), TypeError);
    assert.throws(() => new SessionStore({ secret, ttlMs: 1.5 }), TypeError);
  });
});

describe('SlidingWindowCounter', () => {
  it('counts hits inside the window and reports the limit with a retry time', () => {
    const time = clock();
    const counter = new SlidingWindowCounter({ max: 3, windowMs: 60000, now: time.now });
    assert.equal(counter.hit('a'), 1);
    assert.equal(counter.hit('a'), 2);
    assert.equal(counter.count('a'), 2);
    assert.equal(counter.retryAfterSeconds('a'), 0);
    counter.hit('a');
    assert.equal(counter.retryAfterSeconds('a'), 60);
  });

  it('slides: old hits leave the window and the key becomes available again', () => {
    const time = clock();
    const counter = new SlidingWindowCounter({ max: 2, windowMs: 1000, now: time.now });
    counter.hit('k');
    time.advance(500);
    counter.hit('k');
    time.advance(600);
    assert.equal(counter.count('k'), 1);
    assert.equal(counter.retryAfterSeconds('k'), 0);
  });

  it('returns the exact seconds until the oldest hit expires, rounded up and at least one', () => {
    const time = clock();
    const counter = new SlidingWindowCounter({ max: 3, windowMs: 60000, now: time.now });
    counter.hit('k');
    time.advance(10000);
    counter.hit('k');
    time.advance(10000);
    counter.hit('k');
    time.advance(10000);
    assert.equal(counter.retryAfterSeconds('k'), 30);
    time.advance(29001);
    assert.equal(counter.retryAfterSeconds('k'), 1);
  });

  it('resets a single key', () => {
    const counter = new SlidingWindowCounter({ max: 1, windowMs: 60000, now: clock().now });
    counter.hit('a');
    counter.hit('b');
    counter.reset('a');
    assert.equal(counter.count('a'), 0);
    assert.equal(counter.count('b'), 1);
  });

  it('evicts the oldest key when more keys than maxKeys are tracked', () => {
    const counter = new SlidingWindowCounter({ max: 5, windowMs: 60000, maxKeys: 2, now: clock().now });
    counter.hit('a');
    counter.hit('b');
    counter.hit('c');
    assert.equal(counter.count('a'), 0);
    assert.equal(counter.count('b'), 1);
    assert.equal(counter.count('c'), 1);
  });

  it('validates its constructor arguments', () => {
    assert.throws(() => new SlidingWindowCounter({ max: 0, windowMs: 1000 }), TypeError);
    assert.throws(() => new SlidingWindowCounter({ max: 1, windowMs: 0 }), TypeError);
  });
});
