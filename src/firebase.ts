import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  getDoc,
  getDocFromServer,
  updateDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  increment,
  query,
  orderBy
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const dbId = (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId;
export const db = dbId ? getFirestore(app, dbId) : getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export const ADMIN_EMAIL = 'gladay014@gmail.com';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Boot connection test
export async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log('[Firestore] Connection verified.');
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

export interface ReservationData {
  id: string;
  name: string;
  phone: string;
  email: string;
  platform: string;
  createdAt: string;
  updatedAt?: string | null;
}

export interface FeedbackData {
  id: string;
  text: string;
  createdAt: string;
}

export interface StatsData {
  count: number;
  forceClosed: boolean;
  updatedAt?: string;
}

// 1. Stats and ForceClosed Listeners
export function subscribePublicStats(callback: (stats: StatsData) => void) {
  const statsDocRef = doc(db, 'stats', 'public');
  return onSnapshot(statsDocRef, (snap) => {
    if (snap.exists()) {
      callback(snap.data() as StatsData);
    } else {
      // Initialize stats doc if it doesn't exist
      const initial: StatsData = { count: 0, forceClosed: false, updatedAt: new Date().toISOString() };
      setDoc(statsDocRef, initial).catch(err => console.warn('Could not initialize stats doc:', err));
      callback(initial);
    }
  }, (err) => {
    handleFirestoreError(err, OperationType.GET, 'stats/public');
  });
}

// 2. Submit new reservation
export async function submitReservation(res: Omit<ReservationData, 'id'>): Promise<string> {
  const id = 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const docRef = doc(db, 'reservations', id);
  const statsRef = doc(db, 'stats', 'public');

  const batch = writeBatch(db);
  batch.set(docRef, { ...res, id });
  batch.set(statsRef, {
    count: increment(1),
    forceClosed: false,
    updatedAt: new Date().toISOString()
  }, { merge: true });

  try {
    await batch.commit();
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'reservations/' + id);
    throw err;
  }
}

// 3. Submit feedback memo
export async function submitFeedback(text: string): Promise<string> {
  const id = 'fb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const docRef = doc(db, 'feedback', id);
  try {
    await setDoc(docRef, {
      id,
      text,
      createdAt: new Date().toISOString()
    });
    return id;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'feedback/' + id);
    throw err;
  }
}

// 4. Update status force closed (Admin)
export async function setForceClosed(forceClosed: boolean): Promise<void> {
  const statsRef = doc(db, 'stats', 'public');
  try {
    await updateDoc(statsRef, {
      forceClosed,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, 'stats/public');
  }
}

// 5. Real-time Reservations subscription (Admin)
export function subscribeReservations(
  onData: (items: ReservationData[]) => void,
  onError: (err: unknown) => void
) {
  const colRef = collection(db, 'reservations');
  return onSnapshot(colRef, (snapshot) => {
    const list: ReservationData[] = [];
    snapshot.forEach(docSnap => {
      list.push(docSnap.data() as ReservationData);
    });
    // Sort oldest first (by createdAt)
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    onData(list);
  }, (err) => {
    onError(err);
    handleFirestoreError(err, OperationType.LIST, 'reservations');
  });
}

// 6. Real-time Feedback subscription (Admin)
export function subscribeFeedback(
  onData: (items: FeedbackData[]) => void,
  onError: (err: unknown) => void
) {
  const colRef = collection(db, 'feedback');
  return onSnapshot(colRef, (snapshot) => {
    const list: FeedbackData[] = [];
    snapshot.forEach(docSnap => {
      list.push(docSnap.data() as FeedbackData);
    });
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    onData(list);
  }, (err) => {
    onError(err);
    handleFirestoreError(err, OperationType.LIST, 'feedback');
  });
}

// 7. Admin Single Add
export async function adminAddReservation(data: Omit<ReservationData, 'id'>): Promise<string> {
  return submitReservation(data);
}

// 8. Admin Update
export async function adminUpdateReservation(id: string, updates: Partial<ReservationData>): Promise<void> {
  const docRef = doc(db, 'reservations', id);
  try {
    await updateDoc(docRef, {
      ...updates,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, 'reservations/' + id);
  }
}

// 9. Admin Delete (Single or Multiple)
export async function adminDeleteReservations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const batch = writeBatch(db);
  ids.forEach(id => {
    batch.delete(doc(db, 'reservations', id));
  });
  // Decrement stats
  batch.update(doc(db, 'stats', 'public'), {
    count: increment(-ids.length),
    updatedAt: new Date().toISOString()
  });

  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, 'reservations');
  }
}

// 10. Admin Delete Feedback
export async function adminDeleteFeedback(id: string): Promise<void> {
  const docRef = doc(db, 'feedback', id);
  try {
    await deleteDoc(docRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, 'feedback/' + id);
  }
}

// 11. Auth actions
export async function loginWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

export async function logout(): Promise<void> {
  await signOut(auth);
}
