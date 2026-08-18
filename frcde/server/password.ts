/**
 * Password hashing.
 *
 * scrypt, from Node's own crypto module, rather than argon2id. Argon2id is the
 * stronger recommendation and would be the right call for a real system — but
 * every Node binding for it is a native module, which means a compile step on
 * deploy and a class of build failure that has nothing to do with this
 * application. scrypt is memory-hard, listed by OWASP as an acceptable choice
 * at these parameters, and needs no dependency at all.
 *
 * Stored form is self-describing:
 *
 *     scrypt$N$r$p$<salt base64>$<hash base64>
 *
 * so the cost parameters can be raised later without invalidating existing
 * hashes — an old hash still verifies against the parameters it was made with,
 * and gets re-hashed on the next successful sign-in.
 */

import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * OWASP-listed configuration (N=2^15, r=8, p=3).
 *
 * N=2^17 is the stronger option but wants ~128 MB per hash, which is a poor fit
 * for a 512 MB free-tier instance handling concurrent sign-ins. This costs
 * ~34 MB and is comfortably above the point where a stolen database is worth
 * attacking.
 */
const PARAMS = { N: 32_768, r: 8, p: 3 };
const KEYLEN = 64;
/** Node's default cap is 32 MB, which N=2^15 exceeds. */
const MAXMEM = 128 * 1024 * 1024;

const encode = (N: number, r: number, p: number, salt: Buffer, hash: Buffer) =>
  `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;

/** Synchronous — used only when seeding, where there is no event loop to block. */
export function hashPasswordSync(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return encode(PARAMS.N, PARAMS.r, PARAMS.p, salt, hash);
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(plain, salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return encode(PARAMS.N, PARAMS.r, PARAMS.p, salt, hash);
}

export const isHashed = (stored: string) => stored.startsWith('scrypt$');

/**
 * Verify a password against its stored form.
 *
 * Returns false rather than throwing on a malformed record: a corrupt row
 * should fail the sign-in, not take down the endpoint.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!isHashed(stored)) {
    // A record written before hashing existed. Compared in constant time all
    // the same, and upgraded by the caller on success.
    const a = Buffer.from(plain);
    const b = Buffer.from(stored);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  try {
    const [, n, r, p, saltB64, hashB64] = stored.split('$');
    const N = Number(n);
    const R = Number(r);
    const P = Number(p);
    const salt = Buffer.from(saltB64 ?? '', 'base64');
    const expected = Buffer.from(hashB64 ?? '', 'base64');

    /**
     * Reject a malformed record before deriving anything.
     *
     * Base64 that cannot be decoded yields an *empty* buffer rather than an
     * error, and scrypt will happily return an empty derived key for a zero
     * length — at which point `timingSafeEqual` compares nothing with nothing
     * and reports a match. A corrupt row would then accept any password. Fail
     * closed on anything that does not look like a real stored hash.
     */
    const sane =
      Number.isInteger(N) && N > 1 &&
      Number.isInteger(R) && R > 0 &&
      Number.isInteger(P) && P > 0 &&
      salt.length >= 8 &&
      expected.length >= 16;
    if (!sane) return false;

    const actual = await scryptAsync(plain, salt, expected.length, {
      N,
      r: R,
      p: P,
      maxmem: MAXMEM,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash predates the current cost parameters and should be redone. */
export function needsRehash(stored: string): boolean {
  if (!isHashed(stored)) return true;
  const [, n, r, p] = stored.split('$');
  return Number(n) !== PARAMS.N || Number(r) !== PARAMS.r || Number(p) !== PARAMS.p;
}
