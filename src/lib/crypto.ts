// Криптография СКАМ поверх WebCrypto (без сторонних библиотек).
//
//  • Ключ личности — пара ECDH P-256. Открытая половина лежит на сервере (user_keys),
//    закрытая — только на устройствах (IndexedDB, неизвлекаемый CryptoKey) и в копии,
//    зашифрованной паролем шифрования (PBKDF2-SHA256, 600 000 итераций → AES-256-GCM).
//  • Ключ чата — 32 случайных байта (AES-256-GCM). Для каждого участника он «заворачивается»
//    ключом, который выводится из ECDH(закрытый ключ отправителя, открытый ключ получателя)
//    через HKDF-SHA256.
//  • Сообщение — JSON, зашифрованный ключом чата (AES-256-GCM, случайный IV 12 байт).
//    Дополнительные данные (AAD) привязывают шифротекст к чату, сообщению и автору.
//  • Файл — свой случайный ключ AES-256-GCM на каждый файл; ключ файла лежит внутри
//    зашифрованного сообщения.
// Подробности — ШИФРОВАНИЕ.md.

export type Bytes = Uint8Array<ArrayBuffer>;

/** Итераций PBKDF2 для пароля шифрования (рекомендация OWASP для PBKDF2-HMAC-SHA256). */
export const PBKDF2_ITERATIONS = 600_000;
const IV_LEN = 12;

export class WrongPasswordError extends Error {}

export function cryptoSupported(): boolean {
  return typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle && typeof indexedDB !== 'undefined';
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export function utf8(s: string): Bytes {
  return te.encode(s) as Bytes;
}

export function rand(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function unb64(s: string): Bytes {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Симметричное шифрование: IV (12 байт) ‖ AES-256-GCM(данные) с тегом 16 байт
// ---------------------------------------------------------------------------

export function aesKey(raw: Bytes): Promise<CryptoKey> {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, data: Bytes, aad?: Bytes): Promise<Bytes> {
  const iv = rand(IV_LEN);
  const params: AesGcmParams = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  const ct = new Uint8Array(await subtle().encrypt(params, key, data));
  return concat(iv, ct);
}

export async function open(key: CryptoKey, box: Bytes, aad?: Bytes): Promise<Bytes> {
  if (box.length < IV_LEN + 16) throw new Error('ciphertext too short');
  const iv = box.slice(0, IV_LEN);
  const params: AesGcmParams = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  return new Uint8Array(await subtle().decrypt(params, key, box.slice(IV_LEN)));
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<string> {
  return b64(await seal(key, utf8(JSON.stringify(value)), utf8(aad)));
}

export async function openJson<T>(key: CryptoKey, box: string, aad: string): Promise<T> {
  return JSON.parse(td.decode(await open(key, unb64(box), utf8(aad)))) as T;
}

// ---------------------------------------------------------------------------
// Ключ личности (ECDH P-256)
// ---------------------------------------------------------------------------

const EC: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' };

/** Новая пара ключей. pub — открытый ключ (raw, 65 байт, base64), pkcs8 — закрытый ключ. */
export async function generateIdentity(): Promise<{ pub: string; pkcs8: Bytes }> {
  const kp = (await subtle().generateKey(EC, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', kp.privateKey));
  return { pub: b64(pub), pkcs8 };
}

/** Закрытый ключ для работы: неизвлекаемый — его нельзя выгрузить даже из этой вкладки. */
export function importPrivate(pkcs8: Bytes): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', pkcs8, EC, false, ['deriveBits']);
}

function importPublic(pub: string): Promise<CryptoKey> {
  return subtle().importKey('raw', unb64(pub), EC, false, []);
}

/** Проверка, что закрытый ключ соответствует открытому: ECDH с тестовой парой даёт одинаковый секрет. */
export async function keyPairMatches(priv: CryptoKey, pub: string): Promise<boolean> {
  try {
    const probe = (await subtle().generateKey(EC, true, ['deriveBits'])) as CryptoKeyPair;
    const probePub = b64(new Uint8Array(await subtle().exportKey('raw', probe.publicKey)));
    const a = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: await importPublic(probePub) }, priv, 256));
    const b = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: await importPublic(pub) }, probe.privateKey, 256));
    return a.length === b.length && a.every((x, i) => x === b[i]);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Пароль шифрования: копия закрытого ключа на сервере
// ---------------------------------------------------------------------------

async function passwordKey(password: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', utf8(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const backupAad = (pub: string) => utf8(`skam/key-backup/v1|${pub}`);

export type KeyBackup = { backup: string; salt: string; iterations: number };

export async function sealPrivate(pkcs8: Bytes, password: string, pub: string): Promise<KeyBackup> {
  const salt = rand(16);
  const key = await passwordKey(password, salt, PBKDF2_ITERATIONS);
  return { backup: b64(await seal(key, pkcs8, backupAad(pub))), salt: b64(salt), iterations: PBKDF2_ITERATIONS };
}

export async function openPrivate(b: KeyBackup, password: string, pub: string): Promise<Bytes> {
  const key = await passwordKey(password, unb64(b.salt), b.iterations);
  try {
    return await open(key, unb64(b.backup), backupAad(pub));
  } catch {
    throw new WrongPasswordError('wrong password');
  }
}

// ---------------------------------------------------------------------------
// Ключи чатов: заворачивание для участника
// ---------------------------------------------------------------------------

export type WrapCtx = { chatId: string; keyId: string; userId: string };

async function pairKey(priv: CryptoKey, peerPub: string, c: WrapCtx): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: await importPublic(peerPub) }, priv, 256);
  const hk = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(c.keyId), info: utf8(`skam/chat-key/v1|${c.chatId}|${c.userId}`) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const wrapAad = (c: WrapCtx) => utf8(`${c.chatId}|${c.keyId}|${c.userId}`);

/** Завернуть ключ чата для получателя c.userId (его открытый ключ — recipientPub). */
export async function wrapChatKey(raw: Bytes, myPriv: CryptoKey, recipientPub: string, c: WrapCtx): Promise<string> {
  return b64(await seal(await pairKey(myPriv, recipientPub, c), raw, wrapAad(c)));
}

/** Развернуть ключ чата, завёрнутый для меня (c.userId — это я) отправителем с ключом senderPub. */
export async function unwrapChatKey(wrapped: string, myPriv: CryptoKey, senderPub: string, c: WrapCtx): Promise<Bytes> {
  const raw = await open(await pairKey(myPriv, senderPub, c), unb64(wrapped), wrapAad(c));
  if (raw.length !== 32) throw new Error('bad chat key');
  return raw;
}
