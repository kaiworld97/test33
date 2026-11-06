import {
  googleSignIn,
  logout,
  getAccessToken,
  initAuth,
  getOrCreateSpreadsheet,
  fetchSpreadsheetMeta,
  readReservationsFromSheet,
  appendReservationToSheet,
  updateReservationInSheet,
  deleteRowsInSheet,
  readFeedbackFromSheet,
  appendFeedbackToSheet,
  SheetReservation,
  SheetFeedback,
  SheetMeta,
  ADMIN_EMAIL,
  getLocalReservations,
  saveLocalReservations,
  getLocalFeedback,
  saveLocalFeedback,
  LOCAL_FORCE_CLOSED_KEY,
  getSavedSpreadsheetId,
  clearSavedSpreadsheetId,
  setCustomSpreadsheetId,
  getUserProfile,
  GoogleUserProfile
} from './sheets';
import { User } from 'firebase/auth';

(function () {
  'use strict';

  const PLATFORMS = [
    { id: 'ios', label: '모바일 iOS' },
    { id: 'android', label: '모바일 Android' },
    { id: 'pc', label: 'PC' },
    { id: 'console', label: '콘솔' }
  ];

  let currentMeta: SheetMeta | null = null;
  let reservationsList: SheetReservation[] = [];
  let feedbackList: SheetFeedback[] = [];
  let currentUser: User | GoogleUserProfile | null = null;
  let editingId: string | null = null;
  let query = '';
  let platFilter = '';
  let isLoading = false;

  function $(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  function pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  function stamp(iso?: string | null): string {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function platLabel(id: string): string {
    for (let i = 0; i < PLATFORMS.length; i++) {
      if (PLATFORMS[i].id === id) return PLATFORMS[i].label;
    }
    return id || '-';
  }

  function digits(v: string): string {
    return String(v).replace(/\D/g, '');
  }

  function fmtPhone(d: string): string {
    d = d.slice(0, 11);
    if (d.length > 7) return d.slice(0, 3) + '-' + d.slice(3, d.length - 4) + '-' + d.slice(-4);
    if (d.length > 3) return d.slice(0, 3) + '-' + d.slice(3);
    return d;
  }

  function isEmail(v: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  }

  function maskName(n: string): string {
    const c = Array.from(String(n || ''));
    if (c.length <= 1) return c.join('');
    if (c.length === 2) return c[0] + '*';
    return c[0] + '*'.repeat(c.length - 2) + c[c.length - 1];
  }

  function maskPhone(d: string): string {
    d = String(d || '');
    return d.length < 7 ? '-' : d.slice(0, 3) + '-****-' + d.slice(-4);
  }

  function maskEmail(e: string): string {
    if (!e || e.indexOf('@') < 1) return '-';
    const at = e.indexOf('@');
    const local = e.slice(0, at);
    const keep = local.length <= 2 ? 1 : 2;
    return local.slice(0, keep) + '*'.repeat(Math.max(local.length - keep, 3)) + e.slice(at);
  }

  function isPhone(d: string): boolean {
    return /^01[016789]\d{7,8}$/.test(d);
  }

  function filtered(): SheetReservation[] {
    const q = query.trim().toLowerCase();
    const qd = digits(query);
    return reservationsList.filter((r) => {
      if (platFilter && r.platform !== platFilter) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().indexOf(q) > -1 ||
        (r.email || '').toLowerCase().indexOf(q) > -1 ||
        (qd && r.phone.indexOf(qd) > -1)
      );
    });
  }

  function td(text: string | number, cls?: string): HTMLTableCellElement {
    const c = document.createElement('td');
    c.textContent = String(text);
    if (cls) c.className = cls;
    return c;
  }

  function renderAdmin() {
    const all = reservationsList;
    const rows = filtered().slice().reverse();

    const ca = $('countAdm');
    if (ca) {
      ca.textContent = `총 ${all.length}건 (Google Sheets DB)` + (rows.length !== all.length ? ` · 검색 ${rows.length}건` : '');
    }

    const cb = $('csvBtn') as HTMLButtonElement | null;
    if (cb) cb.disabled = all.length === 0;

    const body = $('tbody');
    if (body) {
      body.textContent = '';
      if (!rows.length) {
        const tr0 = document.createElement('tr');
        const c = td(
          all.length
            ? '조건에 맞는 신청이 없어요.'
            : '구글 스프레드시트에 아직 신청자가 없어요. 신청 페이지에서 접수하거나 "+ 신청 추가"를 눌러보세요.',
          'empty'
        );
        c.colSpan = 9;
        tr0.appendChild(c);
        body.appendChild(tr0);
      }

      rows.forEach((r, idx) => {
        const tr = document.createElement('tr');

        const cellCb = document.createElement('td');
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.className = 'rowchk';
        chk.value = String(r.rowIndex);
        chk.setAttribute('aria-label', maskName(r.name) + ' 선택');
        chk.addEventListener('change', syncSel);
        cellCb.appendChild(chk);
        tr.appendChild(cellCb);

        tr.appendChild(td(r.rowIndex - 1)); // 번호
        tr.appendChild(td(maskName(r.name)));
        tr.appendChild(td(maskPhone(r.phone)));
        tr.appendChild(td(maskEmail(r.email)));
        tr.appendChild(td(platLabel(r.platform)));
        tr.appendChild(td(stamp(r.createdAt)));
        tr.appendChild(td(stamp(r.updatedAt)));

        const ac = document.createElement('td');
        const acw = document.createElement('div');
        acw.style.display = 'flex';
        acw.style.gap = '8px';
        ac.appendChild(acw);

        const be = document.createElement('button');
        be.type = 'button';
        be.className = 'btn small paper';
        be.textContent = '수정';
        be.setAttribute('aria-label', maskName(r.name) + ' 수정');
        be.addEventListener('click', () => {
          openDlg(r.id);
        });

        const bd = document.createElement('button');
        bd.type = 'button';
        bd.className = 'btn small danger';
        bd.textContent = '삭제';
        bd.setAttribute('aria-label', maskName(r.name) + ' 삭제');
        bd.addEventListener('click', () => {
          removeRowIndices([r.rowIndex], maskName(r.name));
        });

        acw.appendChild(be);
        acw.appendChild(bd);
        tr.appendChild(ac);
        body.appendChild(tr);
      });
    }

    const sa = $('selAll') as HTMLInputElement | null;
    if (sa) sa.checked = false;
    syncSel();

    // 피드백 메모 렌더링
    const ml = $('memoList');
    if (ml) {
      ml.textContent = '';
      if (!feedbackList.length) {
        const li0 = document.createElement('li');
        li0.className = 'empty';
        li0.textContent = '아직 남겨진 피드백 메모가 없어요.';
        ml.appendChild(li0);
      } else {
        feedbackList.forEach((m) => {
          const li = document.createElement('li');
          const t = document.createElement('span');
          t.className = 't';
          t.textContent = stamp(m.createdAt);

          const x = document.createElement('span');
          x.className = 'x';
          x.textContent = m.text;

          const d = document.createElement('button');
          d.type = 'button';
          d.className = 'btn small danger';
          d.textContent = '삭제';
          d.setAttribute('aria-label', '메모 삭제');
          d.addEventListener('click', () => {
            ask(`해당 피드백 메모를 삭제할까요?`, async () => {
              const token = getAccessToken();
              if (token && currentMeta) {
                try {
                  await deleteRowsInSheet(currentMeta.spreadsheetId, currentMeta.feedbackSheetId, [m.rowIndex], token);
                } catch (e) {
                  console.warn('Google Sheet memo delete warning:', e);
                }
              }
              const currentFb = getLocalFeedback();
              const remainingFb = currentFb.filter((item: any) => item.id !== m.id);
              saveLocalFeedback(remainingFb);
              await refreshData();
            });
          });

          li.appendChild(t);
          li.appendChild(x);
          li.appendChild(d);
          ml.appendChild(li);
        });
      }
    }
  }

  function syncSel() {
    const checked = document.querySelectorAll('.rowchk:checked');
    const n = checked.length;
    const ds = $('delSel') as HTMLButtonElement | null;
    if (ds) {
      ds.disabled = n === 0;
      ds.textContent = n ? `선택 삭제 (${n})` : '선택 삭제';
    }
  }

  function removeRowIndices(rowIndices: number[], label?: string) {
    if (!rowIndices.length) return;
    const msg = label
      ? `'${label}' 신청자를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`
      : `선택한 ${rowIndices.length}명의 신청자를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`;

    ask(msg, async () => {
      const token = getAccessToken();
      try {
        setBusy(true);
        if (token && currentMeta) {
          await deleteRowsInSheet(currentMeta.spreadsheetId, currentMeta.reservationsSheetId, rowIndices, token);
        }
        // Always sync with local DB
        const currentLocal = getLocalReservations();
        const targetIds = new Set(
          reservationsList.filter((r) => rowIndices.includes(r.rowIndex)).map((r) => r.id)
        );
        const remaining = currentLocal.filter((r: any) => !targetIds.has(r.id));
        saveLocalReservations(remaining);

        await refreshData();
      } catch (err: any) {
        alert('삭제 처리 중 오류가 발생했습니다: ' + err.message);
      } finally {
        setBusy(false);
      }
    });
  }

  function setBusy(busy: boolean) {
    isLoading = busy;
    const syncBtn = $('syncBtn') as HTMLButtonElement | null;
    if (syncBtn) {
      syncBtn.disabled = busy;
      syncBtn.textContent = busy ? '동기화 중...' : '🔄 새로고침';
    }
  }

  async function refreshData() {
    const token = getAccessToken();

    // 1. 구글 토큰이 없는 경우 (비밀번호 로그인 모드) -> 로컬 동기화 DB에서 읽기
    if (!token) {
      const localRows = getLocalReservations();
      reservationsList = localRows.map((r: any, idx: number) => ({
        rowIndex: idx + 2,
        id: r.id || `row_${idx + 2}`,
        name: r.name || '',
        phone: r.phone || '',
        email: r.email || '',
        platform: r.platform || 'pc',
        createdAt: r.createdAt || '',
        updatedAt: r.updatedAt || null
      }));

      const localFb = getLocalFeedback();
      feedbackList = localFb.map((m: any, idx: number) => ({
        rowIndex: idx + 2,
        id: m.id || `fb_${idx + 2}`,
        createdAt: m.createdAt || '',
        text: m.text || ''
      }));

      updateSheetInfoUI();
      renderAdmin();
      return;
    }

    // 2. 구글 토큰이 있는 경우 -> Google Sheets API로 동기화
    try {
      setBusy(true);
      if (!currentMeta) {
        currentMeta = await getOrCreateSpreadsheet(token);
      }

      const sheetRows = await readReservationsFromSheet(
        currentMeta.spreadsheetId,
        currentMeta.reservationsSheetTitle,
        token
      );

      // 로컬 미반영 건이 있다면 구글 시트로 업로드
      const localPending = getLocalReservations();
      const existingIds = new Set(sheetRows.map((r) => r.id));
      const toSync = localPending.filter((p: any) => !existingIds.has(p.id));

      if (toSync.length > 0) {
        for (const item of toSync) {
          const nextNo = sheetRows.length + 1;
          await appendReservationToSheet(
            currentMeta.spreadsheetId,
            currentMeta.reservationsSheetTitle,
            item,
            nextNo,
            token
          );
          sheetRows.push({
            rowIndex: sheetRows.length + 2,
            ...item
          });
        }
      }

      reservationsList = sheetRows;
      saveLocalReservations(reservationsList);

      const fbRows = await readFeedbackFromSheet(
        currentMeta.spreadsheetId,
        currentMeta.feedbackSheetTitle,
        token
      );
      feedbackList = fbRows;
      saveLocalFeedback(feedbackList);

      updateSheetInfoUI();
      renderAdmin();
    } catch (err: any) {
      console.warn('Google Sheets sync error, falling back to local DB:', err);
      // Fallback to local
      const localRows = getLocalReservations();
      reservationsList = localRows.map((r: any, idx: number) => ({
        rowIndex: idx + 2,
        id: r.id || `row_${idx + 2}`,
        name: r.name || '',
        phone: r.phone || '',
        email: r.email || '',
        platform: r.platform || 'pc',
        createdAt: r.createdAt || '',
        updatedAt: r.updatedAt || null
      }));
      updateSheetInfoUI();
      renderAdmin();
    } finally {
      setBusy(false);
    }
  }

  function updateSheetInfoUI() {
    const token = getAccessToken();
    const statusBadge = $('statusBadge');
    const statusBadgeText = $('statusBadgeText');
    const titleEl = $('sheetTitleBadge');
    const emailBadge = $('adminEmailBadge');
    const openBtn = $('openSheetBtn') as HTMLAnchorElement | null;
    const connectBtn = $('connectSheetBtn') as HTMLButtonElement | null;
    const currentSheetText = $('currentSheetText');

    const profile = getUserProfile();
    const userEmail = profile?.email || (currentUser as any)?.email || ADMIN_EMAIL;
    if (emailBadge) {
      emailBadge.textContent = userEmail;
    }

    const savedId = getSavedSpreadsheetId();

    if (token && currentMeta) {
      if (statusBadge) statusBadge.style.background = '#0F9D58';
      if (statusBadgeText) statusBadgeText.textContent = 'GOOGLE SHEETS DB 연동됨';
      if (titleEl) titleEl.textContent = currentMeta.title;
      if (openBtn) {
        openBtn.href = currentMeta.spreadsheetUrl;
        openBtn.hidden = false;
      }
      if (connectBtn) connectBtn.hidden = true;
      if (currentSheetText) {
        currentSheetText.innerHTML = `<a href="${currentMeta.spreadsheetUrl}" target="_blank" rel="noopener noreferrer" style="font-weight:700; color:#0F9D58; text-decoration:underline">${currentMeta.title}</a> (ID: ${currentMeta.spreadsheetId.slice(0, 8)}...)`;
      }
    } else {
      if (statusBadge) statusBadge.style.background = '#1B1A2E';
      if (statusBadgeText) statusBadgeText.textContent = '🔑 관리자 비밀번호 인증됨';
      if (titleEl) titleEl.textContent = '사전예약 관리 DB (로컬 동기화)';
      if (openBtn) openBtn.hidden = true;
      if (connectBtn) connectBtn.hidden = false;
      if (currentSheetText) {
        currentSheetText.textContent = savedId
          ? `저장된 시트 ID (${savedId.slice(0, 8)}... - Google 로그인 시 즉시 동기화)`
          : '연동 대기 중 (Google 계정 로그인 필요)';
      }
    }
  }

  /* CSV 내보내기 */
  function fullStamp(iso?: string | null): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function csvCell(v: unknown): string {
    let str = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    if (/[",\r\n]/.test(str)) str = '"' + str.replace(/"/g, '""') + '"';
    return str;
  }

  function buildCsv(): string {
    const head = ['번호', '이름', '연락처', '이메일', '주 이용 플랫폼', '개인정보 동의', '신청 일시', '최종 수정 일시'];
    const lines = [head.map(csvCell).join(',')];
    reservationsList.forEach((r, i) => {
      lines.push(
        [
          i + 1,
          r.name,
          fmtPhone(r.phone),
          r.email || '',
          platLabel(r.platform),
          '동의',
          fullStamp(r.createdAt),
          fullStamp(r.updatedAt)
        ]
          .map(csvCell)
          .join(',')
      );
    });
    return lines.join('\r\n');
  }

  function openExport() {
    const n = reservationsList.length;
    if (!n) return;
    const ei = $('expInfo');
    if (ei) ei.textContent = `Google 시트 신청자 ${n}건 전체를 CSV로 내려받아요.`;
    const ed = $('expDone');
    if (ed) ed.hidden = true;
    const ef = $('expFallback') as HTMLDetailsElement | null;
    if (ef) {
      ef.hidden = true;
      ef.open = false;
    }
    const d = $('expDlg') as HTMLDialogElement | null;
    if (d && typeof d.showModal === 'function') d.showModal();
    else if (d) d.setAttribute('open', '');
  }

  function doExport() {
    const csv = buildCsv();
    const n = reservationsList.length;
    const t = new Date();
    const name = `lumina-sheets-reservations_${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}.csv`;
    try {
      const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      console.warn('Direct download failed:', e);
    }
    const et = $('expText') as HTMLTextAreaElement | null;
    if (et) et.value = csv;
    const ed = $('expDone');
    if (ed) {
      ed.textContent = `${name} (${n}건)을 내려받았어요.`;
      ed.hidden = false;
    }
    const ef = $('expFallback');
    if (ef) ef.hidden = false;
  }

  function closeExport() {
    const d = $('expDlg') as HTMLDialogElement | null;
    if (d && typeof d.close === 'function') d.close();
    else if (d) d.removeAttribute('open');
  }

  /* 확인 다이얼로그 */
  let onYes: (() => void) | null = null;
  function ask(msg: string, yes: () => void) {
    onYes = yes;
    const cm = $('cfmMsg');
    if (cm) cm.textContent = msg;
    const d = $('cfm') as HTMLDialogElement | null;
    if (d && typeof d.showModal === 'function') d.showModal();
    else if (d) d.setAttribute('open', '');
  }

  function closeAsk() {
    const d = $('cfm') as HTMLDialogElement | null;
    if (d && typeof d.close === 'function') d.close();
    else if (d) d.removeAttribute('open');
  }

  /* 신청 추가/수정 모달 */
  function openDlg(id: string | null) {
    editingId = id;
    const rec = id ? reservationsList.find((r) => r.id === id) : null;
    const dt = $('dlgTitle');
    if (dt) dt.textContent = rec ? '신청 정보 수정' : '신청자 직접 추가';

    const dh = $('dlgHelp');
    if (dh) {
      dh.textContent = rec
        ? '수정된 내용은 구글 스프레드시트의 해당 행에 실시간 반영됩니다.'
        : '새로운 신청자를 구글 스프레드시트에 행으로 추가합니다.';
    }

    const dn = $('d-name') as HTMLInputElement | null;
    const dp = $('d-phone') as HTMLInputElement | null;
    const de = $('d-email') as HTMLInputElement | null;
    const dpl = $('d-plat') as HTMLSelectElement | null;

    if (dn) {
      dn.value = '';
      dn.placeholder = rec ? rec.name : '이름';
    }
    if (dp) {
      dp.value = '';
      dp.placeholder = rec ? fmtPhone(rec.phone) : '010-0000-0000';
    }
    if (de) {
      de.value = '';
      de.placeholder = rec ? rec.email : 'name@example.com';
    }
    if (dpl) {
      dpl.value = rec ? rec.platform : PLATFORMS[0].id;
    }

    ['name', 'phone', 'email', 'plat'].forEach((f) => {
      const el = $('de-' + f);
      if (el) el.textContent = '';
    });

    const d = $('dlg') as HTMLDialogElement | null;
    if (d && typeof d.showModal === 'function') d.showModal();
    else if (d) d.setAttribute('open', '');
    dn?.focus();
  }

  function closeDlg() {
    const d = $('dlg') as HTMLDialogElement | null;
    if (d && typeof d.close === 'function') d.close();
    else if (d) d.removeAttribute('open');
  }

  async function saveDlg(e: Event) {
    e.preventDefault();
    const token = getAccessToken();

    const rec = editingId ? reservationsList.find((r) => r.id === editingId) : null;
    let name = (($('d-name') as HTMLInputElement)?.value || '').trim();
    let phone = digits(($('d-phone') as HTMLInputElement)?.value || '');
    let email = (($('d-email') as HTMLInputElement)?.value || '').trim().toLowerCase();
    const plat = ($('d-plat') as HTMLSelectElement)?.value || PLATFORMS[0].id;

    if (rec) {
      if (!name) name = rec.name;
      if (!phone) phone = rec.phone;
      if (!email) email = rec.email || '';
    }

    ['name', 'phone', 'email', 'plat'].forEach((f) => {
      const el = $('de-' + f);
      if (el) el.textContent = '';
    });

    let ok = true;
    if (name.length < 2) {
      const en = $('de-name');
      if (en) en.textContent = '이름을 2자 이상 입력해 주세요.';
      ok = false;
    }
    if (!isPhone(phone)) {
      const ep = $('de-phone');
      if (ep) ep.textContent = '휴대폰 번호 형식을 확인해 주세요.';
      ok = false;
    }
    if (!isEmail(email)) {
      const ee = $('de-email');
      if (ee) ee.textContent = '이메일 형식을 확인해 주세요.';
      ok = false;
    }

    if (!ok) return;

    try {
      setBusy(true);
      const localAll = getLocalReservations();

      if (rec) {
        if (token && currentMeta) {
          try {
            await updateReservationInSheet(
              currentMeta.spreadsheetId,
              currentMeta.reservationsSheetTitle,
              rec.rowIndex,
              {
                id: rec.id,
                name,
                phone,
                email,
                platform: plat,
                createdAt: rec.createdAt
              },
              rec.rowIndex - 1,
              token
            );
          } catch (e) {
            console.warn('Google Sheet update warning:', e);
          }
        }
        const idx = localAll.findIndex((l: any) => l.id === rec.id);
        if (idx > -1) {
          localAll[idx] = {
            ...localAll[idx],
            name,
            phone,
            email,
            platform: plat,
            updatedAt: new Date().toISOString()
          };
          saveLocalReservations(localAll);
        }
      } else {
        const newId = 'r_' + Date.now().toString(36);
        const orderNum = reservationsList.length + 1;
        const newRecord = {
          id: newId,
          name,
          phone,
          email,
          platform: plat,
          createdAt: new Date().toISOString(),
          updatedAt: null
        };
        if (token && currentMeta) {
          try {
            await appendReservationToSheet(
              currentMeta.spreadsheetId,
              currentMeta.reservationsSheetTitle,
              newRecord,
              orderNum,
              token
            );
          } catch (e) {
            console.warn('Google Sheet append warning:', e);
          }
        }
        localAll.push(newRecord);
        saveLocalReservations(localAll);
      }

      closeDlg();
      await refreshData();
    } catch (err: any) {
      alert('저장 처리 중 오류가 발생했습니다: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  const ADMIN_PASSWORD = 'lumina2026';
  const SESSION_KEY = 'lumina_admin_session';

  function isAuthed(): boolean {
    try {
      return sessionStorage.getItem(SESSION_KEY) === '1' || !!getAccessToken();
    } catch (e) {
      return !!getAccessToken();
    }
  }

  function setSessionAuthed(v: boolean) {
    try {
      if (v) sessionStorage.setItem(SESSION_KEY, '1');
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  function updateView() {
    const authed = isAuthed();
    const vg = $('viewGate');
    const va = $('viewAdmin');

    if (vg) vg.hidden = authed;
    if (va) va.hidden = !authed;

    if (!authed) {
      const epw = $('e-pw');
      if (epw) epw.textContent = '';
      const errBox = $('errBox');
      if (errBox) errBox.style.display = 'none';
    } else {
      updateSheetInfoUI();
      refreshData();
    }
  }

  // 1. 비밀번호 로그인
  function handlePasswordLogin() {
    const pwInput = $('g-pw') as HTMLInputElement | null;
    const val = (pwInput?.value || '').trim();
    const epw = $('e-pw');

    if (val === ADMIN_PASSWORD) {
      if (epw) epw.textContent = '';
      setSessionAuthed(true);
      updateView();
    } else {
      if (epw) {
        epw.textContent = val
          ? '비밀번호가 올바르지 않습니다. (기본 비밀번호: lumina2026)'
          : '관리자 비밀번호를 입력해 주세요.';
      }
      pwInput?.focus();
    }
  }

  $('pwLoginBtn')?.addEventListener('click', handlePasswordLogin);
  $('g-pw')?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handlePasswordLogin();
    }
  });

  $('fillPwBtn')?.addEventListener('click', () => {
    const pwInput = $('g-pw') as HTMLInputElement | null;
    if (pwInput) {
      pwInput.value = ADMIN_PASSWORD;
      pwInput.focus();
    }
  });

  // 2. Google OAuth 로그인
  async function handleGoogleLogin() {
    const epw = $('e-pw');
    const errBox = $('errBox');
    if (epw) epw.textContent = '';
    if (errBox) {
      errBox.style.display = 'none';
      errBox.textContent = '';
    }

    try {
      const res = await googleSignIn();
      currentUser = res.user;
      setSessionAuthed(true);
      const badge = $('adminEmailBadge');
      if (badge) {
        badge.textContent = res.user.email || ADMIN_EMAIL;
      }
      updateView();
    } catch (err: any) {
      console.warn('Google login failed:', err);
      if (errBox) {
        errBox.style.display = 'block';
        errBox.innerHTML = `
          <div style="font-weight: 700; margin-bottom: 4px">⚠️ Google 로그인 안내</div>
          <div>${err.message || '로그인을 진행할 수 없습니다.'}</div>
          <button type="button" class="btn small" id="bypassBtn" style="margin-top: 10px; width: 100%; background: var(--accent); color: var(--ink)">
            👉 관리자 비밀번호(lumina2026)로 지금 즉시 입장하기
          </button>
        `;
        $('bypassBtn')?.addEventListener('click', () => {
          setSessionAuthed(true);
          updateView();
        });
      }
    }
  }

  $('googleLoginBtn')?.addEventListener('click', handleGoogleLogin);
  $('connectSheetBtn')?.addEventListener('click', handleGoogleLogin);

  // 3. 로그아웃
  $('logoutBtn')?.addEventListener('click', async () => {
    setSessionAuthed(false);
    await logout();
    currentUser = null;
    currentMeta = null;
    updateView();
  });

  // 새로고침 버튼
  $('syncBtn')?.addEventListener('click', () => {
    refreshData();
  });

  // 플랫폼 필터 바인딩
  PLATFORMS.forEach((p) => {
    [$('d-plat'), $('pf')].forEach((sel) => {
      if (!sel) return;
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      sel.appendChild(o);
    });
  });
  const pf = $('pf') as HTMLSelectElement | null;
  if (pf) {
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '전체 플랫폼';
    pf.insertBefore(all, pf.firstChild);
    pf.value = '';
  }

  $('q')?.addEventListener('input', (e) => {
    query = (e.target as HTMLInputElement).value;
    renderAdmin();
  });
  $('pf')?.addEventListener('change', (e) => {
    platFilter = (e.target as HTMLSelectElement).value;
    renderAdmin();
  });

  $('addBtn')?.addEventListener('click', () => openDlg(null));

  $('delSel')?.addEventListener('click', () => {
    const checked = Array.from(document.querySelectorAll('.rowchk:checked')) as HTMLInputElement[];
    const rows = checked.map((c) => parseInt(c.value, 10)).filter((n) => !isNaN(n));
    removeRowIndices(rows);
  });

  $('delAll')?.addEventListener('click', () => {
    const rows = reservationsList.map((r) => r.rowIndex);
    if (rows.length) {
      ask(`전체 신청자 ${rows.length}명을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.`, async () => {
        const token = getAccessToken();
        try {
          setBusy(true);
          if (token && currentMeta) {
            await deleteRowsInSheet(currentMeta.spreadsheetId, currentMeta.reservationsSheetId, rows, token);
          }
          saveLocalReservations([]);
          await refreshData();
        } catch (err: any) {
          alert('전체 삭제 실패: ' + err.message);
        } finally {
          setBusy(false);
        }
      });
    }
  });

  $('selAll')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    (Array.from(document.querySelectorAll('.rowchk')) as HTMLInputElement[]).forEach((c) => {
      c.checked = checked;
    });
    syncSel();
  });

  // 마감 토글
  const fc = $('forceClosed') as HTMLInputElement | null;
  if (fc) {
    fc.checked = localStorage.getItem(LOCAL_FORCE_CLOSED_KEY) === '1';
    fc.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      localStorage.setItem(LOCAL_FORCE_CLOSED_KEY, checked ? '1' : '0');
    });
  }

  $('dlgSave')?.addEventListener('click', saveDlg);
  $('dlgCancel')?.addEventListener('click', closeDlg);

  $('csvBtn')?.addEventListener('click', openExport);
  $('expGo')?.addEventListener('click', doExport);
  $('expClose')?.addEventListener('click', closeExport);

  $('cfmNo')?.addEventListener('click', () => {
    onYes = null;
    closeAsk();
  });
  $('cfmYes')?.addEventListener('click', () => {
    const f = onYes;
    onYes = null;
    closeAsk();
    if (f) f();
  });

  $('d-phone')?.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    target.value = fmtPhone(digits(target.value));
  });

  // Google Sheets DB 직접 관리
  $('copySheetIdBtn')?.addEventListener('click', async () => {
    const id = currentMeta?.spreadsheetId || getSavedSpreadsheetId() || '';
    if (!id) {
      alert('연동된 구글 시트 ID가 아직 없습니다.');
      return;
    }
    try {
      await navigator.clipboard.writeText(id);
      const msg = $('sheetStatusMsg');
      if (msg) {
        msg.textContent = `시트 ID(${id})가 클립보드에 복사되었습니다.`;
        setTimeout(() => {
          if (msg) msg.textContent = '';
        }, 3000);
      }
    } catch (e) {
      prompt('시트 ID를 복사하세요:', id);
    }
  });

  $('resetSheetBtn')?.addEventListener('click', () => {
    ask('현재 연동된 구글 시트 연결을 해제하고 새 스프레드시트를 생성하도록 초기화할까요?', async () => {
      clearSavedSpreadsheetId();
      currentMeta = null;
      const msg = $('sheetStatusMsg');
      if (msg) msg.textContent = '시트 설정이 초기화되었습니다. 새로고침 시 새 시트가 생성됩니다.';
      await refreshData();
    });
  });

  $('applyCustomSheetBtn')?.addEventListener('click', async () => {
    const input = $('customSheetInput') as HTMLInputElement | null;
    const val = (input?.value || '').trim();
    if (!val) {
      input?.focus();
      return;
    }
    const newId = setCustomSpreadsheetId(val);
    currentMeta = null;
    if (input) input.value = '';
    const msg = $('sheetStatusMsg');
    if (msg) msg.textContent = `스프레드시트 ID(${newId})를 연결했습니다. 데이터를 불러오는 중...`;
    await refreshData();
  });

  // Firebase auth state listener
  initAuth(
    (user, token) => {
      currentUser = user;
      const badge = $('adminEmailBadge');
      if (badge) badge.textContent = user.email || ADMIN_EMAIL;
      updateView();
    },
    () => {
      // Do not clear session if authenticated via password
      if (!sessionStorage.getItem(SESSION_KEY)) {
        currentUser = null;
        updateView();
      }
    }
  );

  updateView();
})();
