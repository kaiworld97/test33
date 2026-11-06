import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);

export const ADMIN_EMAIL = 'gladay014@gmail.com';

export const SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
];

const provider = new GoogleAuthProvider();
SHEETS_SCOPES.forEach(scope => provider.addScope(scope));
provider.setCustomParameters({
  prompt: 'select_account'
});

export interface GoogleUserProfile {
  email: string;
  name: string;
  picture?: string;
}

// In-memory token & profile cache (never stored in localStorage per Workspace guidelines)
let cachedAccessToken: string | null = null;
let cachedUserProfile: GoogleUserProfile | null = null;
let isSigningIn = false;

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: string; error_description?: string }) => void;
            error_callback?: (err: any) => void;
          }) => {
            requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
          };
        };
      };
    };
  }
}

export async function loadGisScript(): Promise<boolean> {
  if (typeof window !== 'undefined' && window.google?.accounts?.oauth2) {
    return true;
  }
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(false);
    const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(true));
      existing.addEventListener('error', () => resolve(false));
      setTimeout(() => resolve(!!window.google?.accounts?.oauth2), 1500);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    setTimeout(() => resolve(!!window.google?.accounts?.oauth2), 2500);
  });
}

export async function fetchGoogleUserProfile(token: string): Promise<GoogleUserProfile | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      return {
        email: data.email || ADMIN_EMAIL,
        name: data.name || '주최자',
        picture: data.picture
      };
    }
  } catch (e) {
    console.warn('Could not fetch userinfo:', e);
  }
  return null;
}

export async function requestGisToken(): Promise<string> {
  await loadGisScript();
  if (!window.google?.accounts?.oauth2) {
    throw new Error('Google Identity Services 라이브러리를 불러올 수 없습니다.');
  }

  return new Promise((resolve, reject) => {
    try {
      const client = window.google!.accounts.oauth2.initTokenClient({
        client_id: firebaseConfig.oAuthClientId,
        scope: SHEETS_SCOPES.join(' '),
        callback: (resp) => {
          if (resp.error) {
            reject(new Error(resp.error_description || resp.error));
          } else if (resp.access_token) {
            resolve(resp.access_token);
          } else {
            reject(new Error('액세스 토큰을 받지 못했습니다.'));
          }
        },
        error_callback: (err) => {
          reject(err);
        }
      });
      client.requestAccessToken({ prompt: 'consent' });
    } catch (e) {
      reject(e);
    }
  });
}

export const initAuth = (
  onAuthSuccess?: (user: User | GoogleUserProfile, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user && cachedAccessToken) {
      if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
    } else if (cachedAccessToken && cachedUserProfile) {
      if (onAuthSuccess) onAuthSuccess(cachedUserProfile, cachedAccessToken);
    } else {
      if (!isSigningIn) {
        cachedAccessToken = null;
        cachedUserProfile = null;
        if (onAuthFailure) onAuthFailure();
      }
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User | GoogleUserProfile; accessToken: string }> => {
  try {
    isSigningIn = true;

    // 1차 시도: Google Identity Services (GIS) 직접 토큰 요청 (Firebase Auth 허용도메인 제약 없음)
    try {
      const gisToken = await requestGisToken();
      if (gisToken) {
        cachedAccessToken = gisToken;
        const profile = await fetchGoogleUserProfile(gisToken);
        cachedUserProfile = profile || { email: ADMIN_EMAIL, name: '주최자' };
        return { user: cachedUserProfile, accessToken: cachedAccessToken };
      }
    } catch (gisError: any) {
      console.warn('GIS Token Client failed or skipped, trying Firebase Auth popup:', gisError);
    }

    // 2차 시도: Firebase signInWithPopup
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google OAuth access token을 발급받지 못했습니다.');
    }
    cachedAccessToken = credential.accessToken;
    const profile = await fetchGoogleUserProfile(cachedAccessToken);
    cachedUserProfile = profile || { email: result.user.email || ADMIN_EMAIL, name: result.user.displayName || '주최자' };
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Sign-in error:', error);
    const code = error?.code || '';
    if (code === 'auth/unauthorized-domain') {
      throw new Error(
        '현재 미리보기 주소가 Firebase 인증 허용 목록에 등록되지 않았습니다. 관리자 비밀번호(lumina2026)로 로그인해 주세요.'
      );
    }
    if (code === 'auth/popup-blocked') {
      throw new Error(
        '브라우저에서 로그인 팝업 창이 차단되었습니다. 팝업 차단을 해제하거나 관리자 비밀번호(lumina2026)로 로그인해 주세요.'
      );
    }
    if (code === 'auth/popup-closed-by-user') {
      throw new Error('로그인 팝업 창이 닫혔습니다. 다시 시도하시거나 관리자 비밀번호(lumina2026)로 로그인해 주세요.');
    }
    if (code === 'auth/cancelled-popup-request') {
      throw new Error('팝업 요청이 취소되었습니다. 다시 시도해 주세요.');
    }
    throw new Error(error?.message || 'Google 로그인에 실패했습니다. 관리자 비밀번호(lumina2026)로 로그인해 주세요.');
  } finally {
    isSigningIn = false;
  }
};

export const getUserProfile = (): GoogleUserProfile | null => {
  return cachedUserProfile;
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

export const logout = async (): Promise<void> => {
  try {
    await signOut(auth);
  } catch (e) {}
  cachedAccessToken = null;
  cachedUserProfile = null;
};

export interface SheetReservation {
  rowIndex: number; // 1-based row in sheet (e.g. 2 for first data row)
  id: string;
  name: string;
  phone: string;
  email: string;
  platform: string;
  createdAt: string;
  updatedAt?: string | null;
}

export interface SheetFeedback {
  rowIndex: number;
  id: string;
  createdAt: string;
  text: string;
}

export interface SheetMeta {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  reservationsSheetId: number;
  reservationsSheetTitle: string;
  feedbackSheetId: number;
  feedbackSheetTitle: string;
}

const STORAGE_SHEET_KEY = 'lumina_google_spreadsheet_id';

export function getSavedSpreadsheetId(): string | null {
  try {
    return localStorage.getItem(STORAGE_SHEET_KEY);
  } catch (e) {
    return null;
  }
}

export function saveSpreadsheetId(id: string) {
  try {
    localStorage.setItem(STORAGE_SHEET_KEY, id);
  } catch (e) {}
}

export function clearSavedSpreadsheetId() {
  try {
    localStorage.removeItem(STORAGE_SHEET_KEY);
  } catch (e) {}
}

export function parseSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match) return match[1];
  return trimmed;
}

export function setCustomSpreadsheetId(idOrUrl: string): string {
  const parsed = parseSpreadsheetId(idOrUrl);
  if (parsed) {
    saveSpreadsheetId(parsed);
  }
  return parsed;
}

function safeRange(sheetTitle: string, cellRange: string): string {
  const needsQuotes = /[\s'!]/.test(sheetTitle);
  const escaped = sheetTitle.replace(/'/g, "''");
  const prefix = needsQuotes ? `'${escaped}'` : escaped;
  return encodeURIComponent(`${prefix}!${cellRange}`);
}

/**
 * Creates or gets the Google Spreadsheet for Lumina Arcadia
 */
export async function getOrCreateSpreadsheet(token: string): Promise<SheetMeta> {
  const existingId = getSavedSpreadsheetId();
  if (existingId) {
    try {
      const meta = await fetchSpreadsheetMeta(existingId, token);
      if (meta) return meta;
    } catch (e) {
      console.warn('Existing spreadsheet could not be opened, creating a new one...');
    }
  }

  // Create new spreadsheet
  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        title: '[루미나 아카디아] 사전예약 신청자 명단 DB'
      },
      sheets: [
        {
          properties: {
            title: '신청자목록',
            gridProperties: { rowCount: 1000, columnCount: 10, frozenRowCount: 1 }
          },
          data: [
            {
              startRow: 0,
              startColumn: 0,
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: '번호' } },
                    { userEnteredValue: { stringValue: '신청ID' } },
                    { userEnteredValue: { stringValue: '이름' } },
                    { userEnteredValue: { stringValue: '연락처' } },
                    { userEnteredValue: { stringValue: '이메일' } },
                    { userEnteredValue: { stringValue: '플랫폼' } },
                    { userEnteredValue: { stringValue: '신청일시' } },
                    { userEnteredValue: { stringValue: '수정일시' } }
                  ]
                }
              ]
            }
          ]
        },
        {
          properties: {
            title: '피드백메모',
            gridProperties: { rowCount: 500, columnCount: 5, frozenRowCount: 1 }
          },
          data: [
            {
              startRow: 0,
              startColumn: 0,
              rowData: [
                {
                  values: [
                    { userEnteredValue: { stringValue: '메모ID' } },
                    { userEnteredValue: { stringValue: '작성일시' } },
                    { userEnteredValue: { stringValue: '메모내용' } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error('Google Spreadsheet 생성 실패: ' + errText);
  }

  const createdData = await createRes.json();
  const spreadsheetId = createdData.spreadsheetId;
  saveSpreadsheetId(spreadsheetId);

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    title: createdData.properties.title,
    reservationsSheetId: createdData.sheets[0].properties.sheetId,
    reservationsSheetTitle: createdData.sheets[0].properties.title,
    feedbackSheetId: createdData.sheets[1].properties.sheetId,
    feedbackSheetTitle: createdData.sheets[1].properties.title
  };
}

export async function fetchSpreadsheetMeta(spreadsheetId: string, token: string): Promise<SheetMeta> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error('Spreadsheet 메타데이터 조회 실패: ' + res.statusText);
  }
  const data = await res.json();
  const sheets = data.sheets || [];
  const resSheet = sheets.find((s: any) => s.properties.title === '신청자목록') || sheets[0];
  const fbSheet = sheets.find((s: any) => s.properties.title === '피드백메모') || sheets[1] || sheets[0];

  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    title: data.properties?.title || '사전예약 DB',
    reservationsSheetId: resSheet.properties.sheetId,
    reservationsSheetTitle: resSheet.properties.title,
    feedbackSheetId: fbSheet.properties.sheetId,
    feedbackSheetTitle: fbSheet.properties.title
  };
}

/**
 * Fetches all reservations from Google Sheet
 */
export async function readReservationsFromSheet(
  spreadsheetId: string,
  sheetTitle: string,
  token: string
): Promise<SheetReservation[]> {
  const range = safeRange(sheetTitle, 'A2:H');
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error('신청자 목록 조회 실패: ' + res.statusText);
  }
  const data = await res.json();
  const rows = data.values || [];

  return rows.map((row: any[], idx: number) => ({
    rowIndex: idx + 2, // Row 1 is header
    id: row[1] || `row_${idx + 2}`,
    name: row[2] || '',
    phone: row[3] || '',
    email: row[4] || '',
    platform: row[5] || 'pc',
    createdAt: row[6] || '',
    updatedAt: row[7] || null
  }));
}

/**
 * Appends a new reservation to Google Sheet
 */
export async function appendReservationToSheet(
  spreadsheetId: string,
  sheetTitle: string,
  item: Omit<SheetReservation, 'rowIndex'>,
  orderNumber: number,
  token: string
): Promise<void> {
  const range = safeRange(sheetTitle, 'A:H');
  const values = [
    [
      orderNumber,
      item.id,
      item.name,
      item.phone,
      item.email,
      item.platform,
      item.createdAt,
      item.updatedAt || ''
    ]
  ];

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    }
  );
  if (!res.ok) {
    throw new Error('신청자 추가 실패: ' + (await res.text()));
  }
}

/**
 * Updates a reservation row in Google Sheet
 */
export async function updateReservationInSheet(
  spreadsheetId: string,
  sheetTitle: string,
  rowIndex: number,
  item: Partial<SheetReservation>,
  orderNumber: number,
  token: string
): Promise<void> {
  const range = safeRange(sheetTitle, `A${rowIndex}:H${rowIndex}`);
  const values = [
    [
      orderNumber,
      item.id || '',
      item.name || '',
      item.phone || '',
      item.email || '',
      item.platform || '',
      item.createdAt || '',
      new Date().toISOString()
    ]
  ];

  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    }
  );
  if (!res.ok) {
    throw new Error('신청자 정보 수정 실패: ' + (await res.text()));
  }
}

/**
 * Deletes rows in Google Sheet
 */
export async function deleteRowsInSheet(
  spreadsheetId: string,
  sheetId: number,
  rowIndices: number[], // 1-based row numbers
  token: string
): Promise<void> {
  // Sort descending so deleting higher indices does not shift lower indices
  const sorted = [...rowIndices].sort((a, b) => b - a);

  const requests = sorted.map((row) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: row - 1, // 0-based inclusive
        endIndex: row // 0-based exclusive
      }
    }
  }));

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ requests })
  });
  if (!res.ok) {
    throw new Error('행 삭제 실패: ' + (await res.text()));
  }
}

/**
 * Reads feedback memos from Google Sheet
 */
export async function readFeedbackFromSheet(
  spreadsheetId: string,
  sheetTitle: string,
  token: string
): Promise<SheetFeedback[]> {
  const range = safeRange(sheetTitle, 'A2:C');
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return [];
  const data = await res.json();
  const rows = data.values || [];

  return rows.map((row: any[], idx: number) => ({
    rowIndex: idx + 2,
    id: row[0] || `fb_${idx + 2}`,
    createdAt: row[1] || '',
    text: row[2] || ''
  }));
}

/**
 * Appends feedback memo to Google Sheet
 */
export async function appendFeedbackToSheet(
  spreadsheetId: string,
  sheetTitle: string,
  text: string,
  token: string
): Promise<void> {
  const range = safeRange(sheetTitle, 'A:C');
  const values = [[`fb_${Date.now()}`, new Date().toISOString(), text]];

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values })
    }
  );
}

// Local cache for public counter & submissions buffer
export const LOCAL_RESERVATIONS_KEY = 'lumina_reservations_db';
export const LOCAL_FEEDBACK_KEY = 'lumina_feedback_db';
export const LOCAL_FORCE_CLOSED_KEY = 'lumina_force_closed';

export function getLocalReservations(): any[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_RESERVATIONS_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

export function saveLocalReservations(items: any[]) {
  try {
    localStorage.setItem(LOCAL_RESERVATIONS_KEY, JSON.stringify(items));
  } catch (e) {}
}

export function getLocalFeedback(): any[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_FEEDBACK_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

export function saveLocalFeedback(items: any[]) {
  try {
    localStorage.setItem(LOCAL_FEEDBACK_KEY, JSON.stringify(items));
  } catch (e) {}
}
