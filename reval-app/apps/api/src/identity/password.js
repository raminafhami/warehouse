import { Buffer } from "node:buffer";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** @param {string} password @param {Buffer} salt */
function derive(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

/** @param {string} password */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = /** @type {Buffer} */ (await derive(password, salt));
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

/** @param {string} password @param {string | undefined} stored */
export async function verifyPassword(password, stored) {
  const [salt, hash] = stored?.split(":") ?? ["0".repeat(32), "0".repeat(128)];
  const expected = Buffer.from(hash, "hex");
  const actual = /** @type {Buffer} */ (
    await derive(password, Buffer.from(salt, "hex"))
  );
  return (
    Boolean(stored) &&
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}
