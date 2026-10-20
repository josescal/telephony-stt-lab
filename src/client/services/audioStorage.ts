const DB_NAME = 'telephony_stt_lab_audio_db';
const DB_VERSION = 1;
const STORE_NAME = 'test_recordings';

export interface StoredTestAudio {
  id: string;
  wavBytes: Uint8Array;
  sampleRate: number;
  profileId: string;
  createdAt: string;
}

function openAudioDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function saveTestAudioToDb(record: StoredTestAudio): Promise<void> {
  try {
    const db = await openAudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    });
    db.close();
  } catch (err) {
    console.error('Failed to save test audio to IndexedDB:', err);
  }
}

export async function loadTestAudioFromDb(id: string): Promise<StoredTestAudio | null> {
  try {
    const db = await openAudioDb();
    const result = await new Promise<StoredTestAudio | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as StoredTestAudio | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB read failed'));
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function deleteTestAudioFromDb(id: string): Promise<void> {
  try {
    const db = await openAudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
    });
    db.close();
  } catch {
    // Ignore errors
  }
}

export async function clearAllTestAudioFromDb(): Promise<void> {
  try {
    const db = await openAudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'));
    });
    db.close();
  } catch {
    // Ignore errors
  }
}

export function triggerWavDownload(wavBytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(wavBytes.byteLength);
  copy.set(wavBytes);
  const blob = new Blob([copy.buffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
