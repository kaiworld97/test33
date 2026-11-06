import {
  getLocalReservations,
  saveLocalReservations,
  getLocalFeedback,
  saveLocalFeedback,
  getSavedSpreadsheetId,
  getAccessToken,
  fetchSpreadsheetMeta,
  appendReservationToSheet,
  appendFeedbackToSheet,
  LOCAL_FORCE_CLOSED_KEY
} from './sheets';

(function () {
  'use strict';

  // /admin 해시가 남아있을 경우 /admin 페이지로 이동
  if (window.location.hash === '#admin' || window.location.pathname.startsWith('/admin')) {
    window.location.href = '/admin/';
    return;
  }

  const CONFIG = {
    openAt: new Date(2026, 10, 6), // 2026-11-06
    closeAt: new Date(2026, 11, 15, 23, 59, 59), // 2026-12-15
    launchAt: new Date(2026, 11, 17) // 2026-12-17
  };

  const PLATFORMS = [
    { id: 'ios', label: '모바일 iOS' },
    { id: 'android', label: '모바일 Android' },
    { id: 'pc', label: 'PC' },
    { id: 'console', label: '콘솔' }
  ];

  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

  let selectedPlat = '';

  function $(id: string): HTMLElement | null {
    return document.getElementById(id);
  }

  function pad(n: number): string {
    return String(n).padStart(2, '0');
  }

  function dateText(d: Date): string {
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일(' + DAYS[d.getDay()] + ')';
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

  function isPhone(d: string): boolean {
    return /^01[016789]\d{7,8}$/.test(d);
  }

  function isClosed(): boolean {
    const forceClosed = localStorage.getItem(LOCAL_FORCE_CLOSED_KEY) === '1';
    return forceClosed || new Date() > CONFIG.closeAt;
  }

  function setErr(id: string, msg: string) {
    const e = $('e-' + id);
    if (e) e.textContent = msg || '';
    const i = $('f-' + id);
    if (i) {
      i.classList.toggle('bad', !!msg);
      i.setAttribute('aria-invalid', msg ? 'true' : 'false');
    }
  }

  function clearErrs() {
    ['name', 'phone', 'email', 'platform', 'agree'].forEach((f) => {
      setErr(f, '');
    });
    const fa = $('formAlert');
    if (fa) fa.hidden = true;
  }

  function fail(reason: string, level: 'warn' | 'error', focusId: string | null, summary: string | null) {
    (level === 'warn' ? console.warn : console.error)('[신청 저장 실패] 이유: ' + reason);
    const fa = $('formAlert');
    if (summary && fa) {
      fa.textContent = summary;
      fa.hidden = false;
    }
    if (focusId) {
      const el = $(focusId);
      if (el) el.focus();
    }
  }

  /* ---------- 공개 화면 렌더링 ---------- */
  function renderPublic() {
    const currentList = getLocalReservations();
    const cp = $('countPub');
    if (cp) cp.textContent = String(currentList.length);

    const closedState = isClosed();
    const st = $('statusText');
    if (st) st.textContent = closedState ? '사전예약 마감' : '사전예약 진행 중';

    const cb = $('closedBox');
    if (cb) cb.hidden = !closedState;

    const sb = $('submitBtn') as HTMLButtonElement | null;
    if (sb) sb.disabled = closedState;

    const sl = $('submitLabel');
    if (sl) sl.textContent = closedState ? '사전예약이 마감되었어요' : '사전예약 신청하기';

    const today = new Date();
    const todayNorm = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const closeNorm = new Date(CONFIG.closeAt.getFullYear(), CONFIG.closeAt.getMonth(), CONFIG.closeAt.getDate());
    const diff = Math.round((closeNorm.getTime() - todayNorm.getTime()) / 864e5);

    const dd = $('dday');
    if (dd) dd.textContent = closedState ? '마감' : diff <= 0 ? 'D-DAY' : 'D-' + diff;
  }

  function fillDates() {
    const dO = $('dOpen'); if (dO) dO.textContent = dateText(CONFIG.openAt);
    const dC = $('dClose'); if (dC) dC.textContent = dateText(CONFIG.closeAt);
    const dC2 = $('dClose2'); if (dC2) dC2.textContent = dateText(CONFIG.closeAt);
    const dL = $('dLaunch'); if (dL) dL.textContent = dateText(CONFIG.launchAt);
    const ss = $('slSched'); if (ss) ss.textContent = '마감 ' + dateText(CONFIG.closeAt) + ' · 출시 ' + dateText(CONFIG.launchAt);
  }

  function renderChips() {
    const box = $('platforms');
    if (!box) return;
    box.textContent = '';
    PLATFORMS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.label;
      b.className = selectedPlat === p.id ? 'chip on' : 'chip';
      b.setAttribute('aria-pressed', selectedPlat === p.id ? 'true' : 'false');
      b.addEventListener('click', () => {
        selectedPlat = p.id;
        setErr('platform', '');
        renderChips();
      });
      box.appendChild(b);
    });
  }

  /* ---------- 신청 제출 (Google Sheets DB 연동) ---------- */
  async function submit(e: Event) {
    e.preventDefault();
    clearErrs();
    if (isClosed()) {
      renderPublic();
      fail('마감 지남', 'error', null, null);
      return;
    }

    const name = (($('f-name') as HTMLInputElement)?.value || '').trim();
    const phone = digits(($('f-phone') as HTMLInputElement)?.value || '');
    const email = (($('f-email') as HTMLInputElement)?.value || '').trim().toLowerCase();
    const agree = ($('f-agree') as HTMLInputElement)?.checked;

    const bad: string[] = [];
    if (name.length < 2) {
      setErr('name', '이름을 2자 이상 입력해 주세요.');
      bad.push('f-name');
    }
    if (!isPhone(phone)) {
      setErr('phone', '휴대폰 번호 형식을 확인해 주세요.');
      bad.push('f-phone');
    }
    if (!isEmail(email)) {
      setErr('email', '이메일 형식을 확인해 주세요. 예: name@example.com');
      bad.push('f-email');
    }
    if (!selectedPlat) {
      setErr('platform', '플랫폼을 하나 선택해 주세요.');
      bad.push('platforms');
    }
    if (!agree) {
      setErr('agree', '사전예약을 위해 동의가 필요해요.');
      bad.push('f-agree');
    }
    if (bad.length) {
      fail(
        !agree && bad.length === 1 ? '동의 안 함' : '빈칸 또는 형식 오류',
        'error',
        bad[0] === 'platforms' ? null : bad[0],
        '입력 내용을 확인해 주세요. 표시된 항목을 고치면 신청할 수 있어요.'
      );
      return;
    }

    const currentList = getLocalReservations();
    const dupPhone = currentList.some((r: any) => r.phone === phone);
    const dupEmail = currentList.some((r: any) => r.email && r.email === email);
    if (dupPhone || dupEmail) {
      if (dupPhone) setErr('phone', '이미 사전예약된 연락처예요.');
      if (dupEmail) setErr('email', '이미 사전예약된 이메일이에요.');
      fail('중복 신청', 'warn', dupPhone ? 'f-phone' : 'f-email', '이미 접수된 연락처 또는 이메일입니다.');
      return;
    }

    const btn = $('submitBtn') as HTMLButtonElement | null;
    const lbl = $('submitLabel');
    if (btn) btn.disabled = true;
    if (lbl) lbl.textContent = '신청 접수 중...';

    const bar = document.createElement('span');
    bar.className = 'loadbar';
    bar.id = 'bar';
    bar.setAttribute('aria-hidden', 'true');
    btn?.appendChild(bar);

    const newRecord = {
      id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      phone,
      email,
      platform: selectedPlat,
      createdAt: new Date().toISOString(),
      updatedAt: null
    };

    // 로컬/공유 DB에 저장
    currentList.push(newRecord);
    saveLocalReservations(currentList);

    // 구글 시트 토큰이 있으면 구글 시트에 직접 즉시 추가
    const token = getAccessToken();
    const sheetId = getSavedSpreadsheetId();
    if (token && sheetId) {
      try {
        const meta = await fetchSpreadsheetMeta(sheetId, token);
        await appendReservationToSheet(
          meta.spreadsheetId,
          meta.reservationsSheetTitle,
          newRecord,
          currentList.length,
          token
        );
        console.log('[Google Sheets] 구글 스프레드시트에 실시간 행 추가 완료');
      } catch (e) {
        console.warn('Google Sheets append deferred to admin sync:', e);
      }
    }

    setTimeout(() => {
      bar.remove();
      renderPublic();

      const dt = $('doneText');
      if (dt) dt.textContent = `${name}님, 신청해 주셔서 감사합니다. 출시 일정과 혜택 지급 방법은 입력하신 연락처로 안내드릴게요.`;
      const dp = $('donePlat');
      if (dp) dp.textContent = '주 이용 플랫폼: ' + platLabel(selectedPlat);

      const f = $('form');
      if (f) f.hidden = true;
      const d = $('done');
      if (d) {
        d.hidden = false;
        d.scrollIntoView({ block: 'center' });
      }
    }, 600);
  }

  function resetForm() {
    const f = $('form') as HTMLFormElement | null;
    if (f) f.reset();
    selectedPlat = '';
    renderChips();
    clearErrs();
    const d = $('done');
    if (d) d.hidden = true;
    if (f) f.hidden = false;
    renderPublic();
  }

  async function saveMemo() {
    const memoInput = $('memo') as HTMLTextAreaElement | null;
    const t = (memoInput?.value || '').trim();
    if (!t) {
      memoInput?.focus();
      return;
    }
    const msg = $('memoMsg');
    if (msg) msg.textContent = '메모를 저장 중입니다...';

    const feedbackList = getLocalFeedback();
    const fbItem = {
      id: 'fb_' + Date.now().toString(36),
      createdAt: new Date().toISOString(),
      text: t
    };
    feedbackList.push(fbItem);
    saveLocalFeedback(feedbackList);

    const token = getAccessToken();
    const sheetId = getSavedSpreadsheetId();
    if (token && sheetId) {
      try {
        const meta = await fetchSpreadsheetMeta(sheetId, token);
        await appendFeedbackToSheet(meta.spreadsheetId, meta.feedbackSheetTitle, t, token);
      } catch (e) {}
    }

    if (memoInput) memoInput.value = '';
    if (msg) msg.textContent = '메모를 남겼어요. 고맙습니다.';
    setTimeout(() => {
      if (msg) msg.textContent = '';
    }, 4000);
  }

  /* ---------- 캐러셀 ---------- */
  const slides = Array.from(document.querySelectorAll('.slide'));
  let idx = 0;
  let prev = 0;
  let playing = true;

  function off(i: number, base: number) {
    const n = slides.length;
    return ((((i - base + 2) % n) + n) % n) - 2;
  }

  function paint() {
    slides.forEach((el, i) => {
      const o = off(i, idx);
      const jump = Math.abs(o - off(i, prev)) > 2;
      const pos = o === 0 ? 'cur' : Math.abs(o) === 1 ? 'near' : 'far';
      el.className = 'slide b' + i + ' ' + pos + (jump ? ' jump' : '');
      (el as HTMLElement).style.transform = 'translateX(' + o * 100 + '%)';
      el.setAttribute('aria-hidden', o !== 0 ? 'true' : 'false');
    });
    const cn = $('curNo');
    if (cn) cn.textContent = pad(idx + 1);
  }

  function go(n: number) {
    const t = slides.length;
    prev = idx;
    idx = ((n % t) + t) % t;
    paint();
  }

  function setPlay(v: boolean) {
    playing = v;
    const ip = $('icoPause'); if (ip) ip.hidden = !v;
    const ipl = $('icoPlay'); if (ipl) ipl.hidden = v;
    const cp = $('carPlay'); if (cp) cp.setAttribute('aria-label', v ? '자동 재생 일시정지' : '자동 재생 시작');
  }

  function enterKey(id: string, fn: (e: Event) => void) {
    const el = $(id);
    el?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') {
        e.preventDefault();
        fn(e);
      }
    });
  }

  // 초기화 및 바인딩
  fillDates();
  renderChips();
  paint();
  renderPublic();

  // 캐러셀
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    setPlay(false);
  } else {
    setInterval(() => {
      if (playing) go(idx + 1);
    }, 4500);
  }
  $('carPrev')?.addEventListener('click', () => go(idx - 1));
  $('carNext')?.addEventListener('click', () => go(idx + 1));
  $('carPlay')?.addEventListener('click', () => setPlay(!playing));

  $('submitBtn')?.addEventListener('click', submit);
  enterKey('form', submit);

  $('againBtn')?.addEventListener('click', () => {
    resetForm();
    ($('f-name') as HTMLInputElement | null)?.focus();
  });
  $('f-name')?.addEventListener('input', () => setErr('name', ''));
  $('f-phone')?.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    target.value = fmtPhone(digits(target.value));
    setErr('phone', '');
  });
  $('f-email')?.addEventListener('input', () => setErr('email', ''));
  $('f-agree')?.addEventListener('change', () => setErr('agree', ''));
  $('memoBtn')?.addEventListener('click', saveMemo);

  window.addEventListener('storage', () => {
    renderPublic();
  });
})();
