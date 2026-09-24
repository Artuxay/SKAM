// Маленькое хранилище «ключ → значение» в IndexedDB. Здесь живёт закрытый ключ шифрования:
// CryptoKey сохраняется как есть (неизвлекаемым), а не в виде байтов.

const DB = 'skam';
const STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export function idbGet<T>(key: string): Promise<T | undefined> {
  return run<T | undefined>('readonly', (s) => s.get(key));
}

export function idbPut(key: string, value: unknown): Promise<void> {
  return run<void>('readwrite', (s) => s.put(value, key));
}

export function idbDel(key: string): Promise<void> {
  return run<void>('readwrite', (s) => s.delete(key));
}
