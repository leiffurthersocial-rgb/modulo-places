// Versioned local save of the persistent student record (wrapped in try/catch: private mode,
// blocked storage etc. must never break the game).
import { migrateRecord, newRecord, type StudentRecord } from '../sim/record';

const KEY = 'modulo-classroom:record';

export function loadRecord(): StudentRecord {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migrateRecord(JSON.parse(raw)) : newRecord();
  } catch {
    return newRecord();
  }
}

export function saveRecord(r: StudentRecord): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
    return true;
  } catch {
    return false;
  }
}

export function hasSave(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
