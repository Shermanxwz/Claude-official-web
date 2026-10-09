// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SessionStore,
  SlidingWindowCounter,
  canonicalExactOrigin,
  isAllowedHost,
  isLoopbackHost,
  randomToken,
  safeEqualText,
  sameOrigin,
  secureHeaders,
  sha256Hex,
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

/**
 * @param {string} token
 * @returns {number} the issue time embedded in a v1 session token
 */
function issuedAtOf(token) {
  return Number(token.split('.')[1]);
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

  it('computes lowercase hex SHA-256 digests', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('accepts loopback Host names on any port and nothing else without a public origin', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:4180', 'localhost', 'LocalHost:65535', '[::1]', '[::1]:1']) {
      assert.equal(isAllowedHost(host), true, host);
    }
    for (const host of ['', undefined, 'localhost.', '127.0.0.1:0', '127.0.0.1:65536', '::1', '[::1]:', 'evil.example',
      '127.0.0.1.nip.io', 'localhost:4180:4180', '10.0.0.5:4180', ['localhost', 'evil.example']]) {
      assert.equal(isAllowedHost(host), false, String(host));
    }
  });

  it('additionally accepts exactly the host[:port] of the public origin', () => {
    assert.equal(isAllowedHost('gw.example', 'https://gw.example'), true);
    assert.equal(isAllowedHost('GW.example', 'https://gw.example'), true);
    assert.equal(isAllowedHost('gw.example:8443', 'https://gw.example:8443'), true);
    assert.equal(isAllowedHost('gw.example:8443', 'https://gw.example'), false);
    assert.equal(isAllowedHost('gw.example', 'https://gw.example:8443'), false);
    assert.equal(isAllowedHost('sub.gw.example', 'https://gw.example'), false);
    assert.equal(isAllowedHost('gw.example.evil', 'https://gw.example'), false);
    assert.equal(isAllowedHost('127.0.0.1:4180', 'https://gw.example'), true, 'loopback names stay allowed');
    assert.equal(isAllowedHost('gw.example', 'not an origin'), false);
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

  it('forgets revocations once their tokens would have expired', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 1000, now: time.now, maxRevoked: 2 });
    store.revoke(store.create());
    time.advance(1000);
    const later = store.create();
    store.revoke(later);
    assert.equal(store.revokedCount, 1);
    assert.deepEqual(Object.keys(store.exportState().entries), [sha256Hex(later)]);
  });

  it('ignores revocations of tokens that have already expired', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 1000, now: time.now });
    const token = store.create();
    time.advance(1000);
    store.revoke(token);
    assert.equal(store.revokedCount, 0);
  });

  it('keeps an evicted revocation rejected by raising the cutoff to its issue time', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 60000, now: time.now, maxRevoked: 2 });
    /** @type {string[]} */
    const tokens = [];
    for (let index = 0; index < 4; index += 1) {
      tokens.push(store.create());
      time.advance(10);
    }
    const [first, second, third, fourth] = tokens;
    store.revoke(first);
    store.revoke(second);
    store.revoke(third);
    assert.equal(store.has(first), false, 'the evicted revocation stays in force');
    assert.equal(store.has(second), false);
    assert.equal(store.has(third), false);
    assert.equal(store.has(fourth), true, 'a token issued after the cutoff is unaffected');
    assert.equal(store.revokedCount, 2);
    assert.equal(store.exportState().revokedBefore, issuedAtOf(first));
  });

  it('rejects every token issued at or before the cutoff, including ones that were never revoked', () => {
    const time = clock();
    const earlier = new SessionStore({ secret, ttlMs: 60000, now: clock(time.now() - 5).now }).create();
    const store = new SessionStore({ secret, ttlMs: 60000, now: time.now, maxRevoked: 1 });
    const first = store.create();
    time.advance(10);
    const second = store.create();
    store.revoke(first);
    assert.equal(store.has(earlier), true, 'nothing has been evicted yet');
    store.revoke(second);
    assert.equal(store.has(earlier), false, 'issued before the evicted revocation, so it ends with it');
    assert.equal(store.has(first), false);
    assert.equal(store.has(second), false);
  });

  it('covers tokens issued in the same millisecond as the evicted one', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 60000, now: time.now, maxRevoked: 1 });
    const first = store.create();
    const sibling = store.create();
    store.revoke(first);
    store.revoke(sibling);
    assert.equal(store.has(first), false);
    assert.equal(store.has(sibling), false);
    assert.equal(store.revokedCount, 0, 'the cutoff covers both, so neither needs an entry');
  });

  it('does not let an older revocation displace a newer one', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 60000, now: time.now, maxRevoked: 1 });
    const older = store.create();
    time.advance(10);
    const newer = store.create();
    store.revoke(newer);
    store.revoke(older);
    assert.equal(store.has(newer), false);
    assert.equal(store.has(older), false);
    assert.equal(store.revokedCount, 1);
    assert.equal(store.exportState().revokedBefore, issuedAtOf(older));
  });

  it('exports digests with issue times and the cutoff, never the cookie value', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 10000, now: time.now });
    const token = store.create();
    store.revoke(token);
    const state = store.exportState();
    assert.deepEqual(state, { entries: { [sha256Hex(token)]: issuedAtOf(token) }, revokedBefore: null });
    assert.equal(JSON.stringify(state).includes(token), false, 'the cookie value itself is never exported');
  });

  it('restores revocations and the cutoff into a new store with the same secret', () => {
    const time = clock();
    const issuer = new SessionStore({ secret, ttlMs: 60000, now: time.now, maxRevoked: 1 });
    const older = issuer.create();
    time.advance(10);
    const newer = issuer.create();
    issuer.revoke(older);
    issuer.revoke(newer);
    const restored = new SessionStore({ secret, ttlMs: 60000, now: time.now, maxRevoked: 1 });
    restored.importState(JSON.parse(JSON.stringify(issuer.exportState())));
    assert.equal(restored.has(older), false, 'the cutoff survives the restart');
    assert.equal(restored.has(newer), false, 'the stored revocation survives the restart');
    assert.deepEqual(restored.exportState(), issuer.exportState());
  });

  it('recomputes expiry from the issue time with the TTL of the restoring store', () => {
    const time = clock();
    const issuer = new SessionStore({ secret, ttlMs: 10000, now: time.now });
    issuer.revoke(issuer.create());
    const state = issuer.exportState();
    time.advance(500);
    const shorter = new SessionStore({ secret, ttlMs: 1000, now: time.now });
    shorter.importState(state);
    assert.equal(shorter.revokedCount, 1, 'still inside the shorter TTL');
    time.advance(500);
    const expired = new SessionStore({ secret, ttlMs: 1000, now: time.now });
    expired.importState(state);
    assert.equal(expired.revokedCount, 0, 'expired under the shorter TTL');
  });

  it('drops expired, malformed and cutoff-covered entries when importing', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 10000, now: time.now });
    const now = time.now();
    store.importState({
      entries: {
        [sha256Hex('live')]: now - 5000,
        [sha256Hex('expired')]: now - 10000,
        [sha256Hex('covered')]: now - 6000,
        'not-a-digest': now,
        [sha256Hex('upper').toUpperCase()]: now,
        [sha256Hex('text')]: String(now),
      },
      revokedBefore: now - 6000,
    });
    assert.deepEqual(Object.keys(store.exportState().entries), [sha256Hex('live')]);
    assert.equal(store.exportState().revokedBefore, now - 6000);
  });

  it('moves the earliest-issued entries under the cutoff when importing more than maxRevoked', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 100000, now: time.now, maxRevoked: 2 });
    const now = time.now();
    store.importState({
      entries: { [sha256Hex('a')]: now - 30, [sha256Hex('b')]: now - 10, [sha256Hex('c')]: now - 20 },
      revokedBefore: null,
    });
    const state = store.exportState();
    assert.deepEqual(Object.keys(state.entries).sort(), [sha256Hex('b'), sha256Hex('c')].sort());
    assert.equal(state.revokedBefore, now - 30);
  });

  it('ignores malformed state without failing', () => {
    const time = clock();
    const store = new SessionStore({ secret, ttlMs: 10000, now: time.now });
    const token = store.create();
    for (const state of ['garbage', null, [], { entries: 'x' }, { entries: [], revokedBefore: 'soon' },
      { entries: {}, revokedBefore: -2 }, { entries: {}, revokedBefore: 1.5 }]) {
      store.importState(state);
    }
    assert.equal(store.has(token), true);
    assert.equal(store.exportState().revokedBefore, null);
  });

  it('validates its constructor arguments', () => {
    assert.throws(() => new SessionStore({ secret: '', ttlMs: 1000 }), TypeError);
    assert.throws(() => new SessionStore({ secret, ttlMs: 0 }), TypeError);
    assert.throws(() => new SessionStore({ secret, ttlMs: 1.5 }), TypeError);
    assert.throws(() => new SessionStore({ secret, ttlMs: 1000, maxRevoked: 0 }), TypeError);
    assert.throws(() => new SessionStore({ secret, ttlMs: 1000, maxRevoked: 1.5 }), TypeError);
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
