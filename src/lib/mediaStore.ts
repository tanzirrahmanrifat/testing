/**
 * Stores media blobs (images/audio/video extracted from .apkg files) in IndexedDB.
 *
 * We use IndexedDB instead of localStorage because:
 *  - localStorage has a ~5-10MB total quota and can only store strings, which
 *    would mean base64-encoding every image/video (~33% size overhead) and
 *    blowing the quota almost immediately on any deck with real media.
 *  - IndexedDB can store Blobs directly and has a much larger (browser-managed)
 *    quota, which is what video/audio files need.
 */

const DB_NAME = 'flashstudy-media';
const STORE_NAME = 'blobs';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open media database.'));
  });

  return dbPromise;
}

function mediaKey(mediaSetId: string, filename: string): string {
  return `${mediaSetId}::${filename}`;
}

/** Stores many media blobs for a single import in one transaction. */
export async function putMediaBatch(mediaSetId: string, files: Map<string, Blob>): Promise<void> {
  if (files.size === 0) return;
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const [filename, blob] of files) {
      store.put(blob, mediaKey(mediaSetId, filename));
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to store media.'));
  });
}

async function getMediaBlob(mediaSetId: string, filename: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(mediaKey(mediaSetId, filename));
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error ?? new Error('Failed to read media.'));
  });
}

/** Deletes all media belonging to a given import (used when a deck is removed). */
export async function deleteMediaSet(mediaSetId: string): Promise<void> {
  const db = await openDb();
  const prefix = `${mediaSetId}::`;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
        store.delete(cursor.key);
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete media.'));
  });
}

// In-memory cache of already-created object URLs so we don't re-read from
// IndexedDB or leak duplicate blob URLs every time a card re-renders.
const objectUrlCache = new Map<string, string>();
const pendingLookups = new Map<string, Promise<string | null>>();

/** Resolves a media filename to a usable object URL, caching the result. */
export function getMediaObjectUrl(mediaSetId: string, filename: string): Promise<string | null> {
  const key = mediaKey(mediaSetId, filename);

  const cached = objectUrlCache.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = pendingLookups.get(key);
  if (pending) return pending;

  const lookup = getMediaBlob(mediaSetId, filename)
    .then((blob) => {
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      objectUrlCache.set(key, url);
      return url;
    })
    .catch(() => null)
    .finally(() => {
      pendingLookups.delete(key);
    });

  pendingLookups.set(key, lookup);
  return lookup;
}
