/* 우리 달력: 시스템 캘린더 위젯·당일 알림 도구
 *
 * 부모 앱 연동 계약
 * 1) 설정 화면에 다음 버튼을 삽입합니다.
 *    <button id="calendar-tools-open">위젯·당일 알림</button>
 * 2) IIFE 안의 최신 상태를 넘기기 위해 아래 둘 중 하나를 사용합니다.
 *    window.UriTools.setContextProvider(() => ({
 *      events: Object.values(db.events),
 *      settings: db.settings,
 *      googleCalendar: { onConnect: () => { ...부모가 구현... } }
 *    }));
 *    또는 window.UriTools.open({ events, settings, googleCalendar: { onConnect } });
 * 3) Google 캘린더 자동 동기화는 이 파일이 인증하거나 전송하지 않습니다.
 *    googleCalendar.onConnect 또는 setGoogleCalendarHook(fn)으로 부모 구현을 호출합니다.
 *
 * 이 파일은 외부 네트워크 요청을 하지 않으며 ICS를 브라우저 메모리에서만 생성합니다.
 */
(function (global) {
  'use strict';

  const VERSION = '1.0.0';
  const DEFAULT_TIME_ZONE = 'Asia/Seoul';
  const STORAGE_KEY = 'uri_tools_preferences_v1';
  const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const VALID_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  let contextProvider = null;
  let googleCalendarHook = null;
  let lastContext = null;
  let root = null;
  let keyHandler = null;

  const pad = n => String(n).padStart(2, '0');
  const asArray = value => Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.values(value) : []);
  const safeText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

  function readPreferences() {
    try {
      const value = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || '{}');
      return { reminderTime: VALID_TIME.test(value.reminderTime) ? value.reminderTime : '09:00' };
    } catch (_) {
      return { reminderTime: '09:00' };
    }
  }

  function savePreferences(value) {
    try { global.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch (_) { /* 선택값 저장 실패는 기능을 막지 않음 */ }
  }

  function parseDate(value) {
    if (!VALID_DATE.test(value || '')) return null;
    const parts = value.split('-').map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) return null;
    return { year: parts[0], month: parts[1], day: parts[2] };
  }

  function addDays(value, amount) {
    const parts = parseDate(value);
    if (!parts) return value;
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }

  function compactDate(value) { return value.replace(/-/g, ''); }
  function compactLocal(value, time) { return `${compactDate(value)}T${time.replace(':', '')}00`; }

  function utcStamp(date) {
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  }

  function localSeoulToUtc(dateValue, timeValue) {
    const date = parseDate(dateValue);
    const time = VALID_TIME.test(timeValue || '') ? timeValue.split(':').map(Number) : [0, 0];
    if (!date) return null;
    return new Date(Date.UTC(date.year, date.month - 1, date.day, time[0] - 9, time[1], 0));
  }

  function minuteBefore(dateValue, timeValue) {
    const date = parseDate(dateValue);
    if (!date || !VALID_TIME.test(timeValue || '')) return null;
    const parts = timeValue.split(':').map(Number);
    const value = new Date(Date.UTC(date.year, date.month - 1, date.day, parts[0], parts[1] - 1, 0));
    return {
      date: `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`,
      time: `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`
    };
  }

  function compareClock(left, right) {
    if (!VALID_TIME.test(left || '') || !VALID_TIME.test(right || '')) return 0;
    return Number(left.slice(0, 2)) * 60 + Number(left.slice(3)) - Number(right.slice(0, 2)) * 60 - Number(right.slice(3));
  }

  function escapeIcs(value) {
    return String(value == null ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\r?\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function utf8Length(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function foldLine(line) {
    if (utf8Length(line) <= 73) return line;
    const output = [];
    let part = '';
    for (const char of line) {
      if (part && utf8Length(part + char) > 73) {
        output.push(part);
        part = ' ' + char;
      } else {
        part += char;
      }
    }
    if (part) output.push(part);
    return output.join('\r\n');
  }

  function normalizeEvent(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const start = parseDate(raw.start) ? raw.start : '';
    if (!start) return null;
    const end = parseDate(raw.end) && raw.end >= start ? raw.end : start;
    const timed = raw.allDay === false && VALID_TIME.test(raw.st || '');
    let endTime = timed && VALID_TIME.test(raw.et || '') ? raw.et : (timed ? raw.st : '');
    if (timed && end === start && compareClock(endTime, raw.st) < 0) endTime = raw.st;
    return {
      id: safeText(raw.id, 80) || `event-${index + 1}`,
      title: safeText(raw.title, 200) || '(제목 없음)',
      start,
      end,
      allDay: !timed,
      startTime: timed ? raw.st : '',
      endTime,
      memo: safeText(raw.memo, 2000),
      owner: ['a', 'b', 'both'].includes(raw.owner) ? raw.owner : '',
      updated: Number.isFinite(raw.updated) ? raw.updated : 0
    };
  }

  function ownerLabel(owner, settings) {
    if (owner === 'both') return '함께';
    if (owner === 'a') return safeText(settings && settings.nameA, 40) || 'A';
    if (owner === 'b') return safeText(settings && settings.nameB, 40) || 'B';
    return '';
  }

  function makeUid(event) {
    const clean = event.id.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80) || 'event';
    return `${clean}@uri-calendar.local`;
  }

  function resolveReminder(event, requestedTime) {
    if (event.allDay) return { date: event.start, time: requestedTime, adjusted: false, crossedDay: false };
    if (compareClock(requestedTime, event.startTime) < 0) {
      return { date: event.start, time: requestedTime, adjusted: false, crossedDay: false };
    }
    const adjusted = minuteBefore(event.start, event.startTime);
    return {
      date: adjusted.date,
      time: adjusted.time,
      adjusted: true,
      crossedDay: adjusted.date !== event.start
    };
  }

  function buildIcs(input, options) {
    const context = input && typeof input === 'object' ? input : {};
    const opts = options && typeof options === 'object' ? options : {};
    const settings = context.settings && typeof context.settings === 'object' ? context.settings : {};
    const reminderTime = VALID_TIME.test(opts.reminderTime || '') ? opts.reminderTime : '09:00';
    const includeAlarm = opts.includeAlarm !== false;
    const events = asArray(context.events).map(normalizeEvent).filter(Boolean).sort((a, b) => {
      const ak = a.start + a.startTime + a.title;
      const bk = b.start + b.startTime + b.title;
      return ak.localeCompare(bk, 'ko');
    });
    const now = opts.now instanceof Date ? opts.now : new Date();
    const stamp = utcStamp(now);
    const lines = [
      'BEGIN:VCALENDAR',
      'PRODID:-//URI Calendar//Widget and Reminder Tools//KO',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeIcs(opts.calendarName || '우리 달력')}`,
      `X-WR-TIMEZONE:${DEFAULT_TIME_ZONE}`,
      'BEGIN:VTIMEZONE',
      `TZID:${DEFAULT_TIME_ZONE}`,
      `X-LIC-LOCATION:${DEFAULT_TIME_ZONE}`,
      'BEGIN:STANDARD',
      'TZOFFSETFROM:+0900',
      'TZOFFSETTO:+0900',
      'TZNAME:KST',
      'DTSTART:19700101T000000',
      'END:STANDARD',
      'END:VTIMEZONE'
    ];
    const summary = { total: events.length, alarms: 0, adjusted: 0, crossedDay: 0, skipped: asArray(context.events).length - events.length };

    for (const event of events) {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${escapeIcs(makeUid(event))}`);
      lines.push(`DTSTAMP:${stamp}`);
      if (event.updated > 0) lines.push(`LAST-MODIFIED:${utcStamp(new Date(event.updated))}`);
      lines.push(`SUMMARY:${escapeIcs(event.title)}`);
      const label = ownerLabel(event.owner, settings);
      if (label) lines.push(`CATEGORIES:${escapeIcs(label)}`);
      if (event.memo) lines.push(`DESCRIPTION:${escapeIcs(event.memo)}`);
      if (event.allDay) {
        lines.push(`DTSTART;VALUE=DATE:${compactDate(event.start)}`);
        lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(event.end, 1))}`);
      } else {
        lines.push(`DTSTART;TZID=${DEFAULT_TIME_ZONE}:${compactLocal(event.start, event.startTime)}`);
        // 시작과 종료가 완전히 같으면 0분 일정이 되므로 DTEND를 생략합니다.
        // 캘린더 앱이 자체 기본 길이로 표시하게 해 호환성을 높입니다.
        if (event.end !== event.start || event.endTime !== event.startTime) {
          lines.push(`DTEND;TZID=${DEFAULT_TIME_ZONE}:${compactLocal(event.end, event.endTime)}`);
        }
      }
      if (includeAlarm) {
        const reminder = resolveReminder(event, reminderTime);
        const alarmUtc = localSeoulToUtc(reminder.date, reminder.time);
        if (alarmUtc) {
          lines.push('BEGIN:VALARM');
          lines.push(`TRIGGER;VALUE=DATE-TIME:${utcStamp(alarmUtc)}`);
          lines.push('ACTION:DISPLAY');
          lines.push(`DESCRIPTION:${escapeIcs(event.title)} 알림`);
          lines.push('END:VALARM');
          summary.alarms += 1;
          if (reminder.adjusted) summary.adjusted += 1;
          if (reminder.crossedDay) summary.crossedDay += 1;
        }
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return { text: lines.map(foldLine).join('\r\n') + '\r\n', summary, events };
  }

  function downloadIcs(context, options) {
    const result = buildIcs(context, options);
    if (!result.summary.total) throw new Error('내보낼 일정이 없어요.');
    const blob = new Blob([result.text], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const today = new Date();
    link.href = url;
    link.download = `우리달력-${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.ics`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return result.summary;
  }

  function ensureStyles() {
    if (document.getElementById('uri-tools-style')) return;
    const style = document.createElement('style');
    style.id = 'uri-tools-style';
    style.textContent = `
      .uri-tools-root{position:fixed;inset:0;z-index:1000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1d1d1f}
      .uri-tools-dim{position:absolute;inset:0;background:rgba(0,0,0,.42)}
      .uri-tools-panel{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:min(100%,560px);max-height:min(88vh,760px);display:flex;flex-direction:column;background:#fff;border-radius:22px 22px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.18);padding-bottom:max(12px,env(safe-area-inset-bottom))}
      .uri-tools-grab{width:38px;height:5px;border-radius:5px;background:#d6d8dc;margin:8px auto 2px}
      .uri-tools-head{display:flex;align-items:center;justify-content:space-between;padding:10px 16px 8px}
      .uri-tools-head h2{font-size:19px;margin:0;font-weight:800}
      .uri-tools-close{width:36px;height:36px;border:0;border-radius:50%;background:#f1f2f4;font-size:23px;line-height:1;cursor:pointer}
      .uri-tools-body{overflow:auto;padding:0 16px 18px;-webkit-overflow-scrolling:touch}
      .uri-tools-summary{margin:4px 0 12px;padding:12px 14px;border-radius:14px;background:#f4f6fb;font-size:14px;line-height:1.55}
      .uri-tools-card{border:1px solid #e3e5e9;border-radius:16px;padding:14px;margin-top:12px}
      .uri-tools-card h3{font-size:15px;margin:0 0 8px;font-weight:800}
      .uri-tools-card p,.uri-tools-card li{font-size:13px;line-height:1.6;color:#555}
      .uri-tools-card p{margin:6px 0}.uri-tools-card ul{margin:6px 0 0;padding-left:19px}
      .uri-tools-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px}
      .uri-tools-row label{font-size:14px;font-weight:700}
      .uri-tools-time{border:1px solid #dfe1e5;border-radius:10px;background:#f7f7f8;padding:9px 10px;font-size:16px}
      .uri-tools-primary,.uri-tools-secondary{width:100%;border:0;border-radius:12px;padding:13px 14px;font-size:14px;font-weight:800;cursor:pointer}
      .uri-tools-primary{margin-top:12px;background:#1d1d1f;color:#fff}.uri-tools-secondary{margin-top:9px;background:#f0f1f3;color:#1d1d1f}
      .uri-tools-primary:disabled,.uri-tools-secondary:disabled{opacity:.45;cursor:not-allowed}
      .uri-tools-status{min-height:20px;margin:9px 2px 0;font-size:13px;font-weight:700;color:#315f9f}
      .uri-tools-caution{color:#9a5b13!important}
      @media(min-width:600px){.uri-tools-panel{bottom:5vh;border-radius:22px;max-height:90vh}.uri-tools-root{padding:20px}}
    `;
    document.head.appendChild(style);
  }

  function eventCount(context) {
    return asArray(context && context.events).map(normalizeEvent).filter(Boolean).length;
  }

  function render(context) {
    ensureStyles();
    close();
    lastContext = context && typeof context === 'object' ? context : {};
    const preferences = readPreferences();
    const count = eventCount(lastContext);
    root = document.createElement('div');
    root.className = 'uri-tools-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '위젯 및 당일 알림 설정');
    root.innerHTML = `
      <div class="uri-tools-dim" data-uri-close></div>
      <section class="uri-tools-panel">
        <div class="uri-tools-grab"></div>
        <header class="uri-tools-head"><h2>위젯·당일 알림</h2><button class="uri-tools-close" data-uri-close aria-label="닫기">×</button></header>
        <div class="uri-tools-body">
          <div class="uri-tools-summary"><b>현재 일정 ${count}개</b><br>ICS 파일은 이 기기 안에서만 만들며 서버로 보내지 않아요.</div>
          <section class="uri-tools-card">
            <h3>Google 캘린더 자동 동기화 <small style="color:#315f9f">권장</small></h3>
            <p>개인 Google 계정에 전용 캘린더를 만들면 우리 달력의 추가·수정·삭제가 약 15분 간격으로 반영돼요. 앱을 열지 않아도 홈 화면 위젯에서 확인할 수 있어요.</p>
            <button class="uri-tools-primary" data-uri-google>Google 캘린더 자동 동기화 연결</button>
          </section>
          <section class="uri-tools-card">
            <h3>계정 연결 없이 한 번 가져오기</h3>
            <p>두 기기에서 각각 파일을 저장하고 시스템 캘린더로 가져오면 홈 화면 캘린더 위젯과 OS 알림을 사용할 수 있어요.</p>
            <div class="uri-tools-row"><label for="uri-tools-time">당일 알림 시간</label><input class="uri-tools-time" id="uri-tools-time" type="time" value="${preferences.reminderTime}" step="300"></div>
            <p class="uri-tools-caution">시간 일정은 선택한 알림 시간이 시작 시각과 같거나 늦으면 시작 1분 전으로 조정해요. 자정 일정은 전날 23:59로 넘어갈 수 있어요.</p>
            <button class="uri-tools-primary" data-uri-export ${count ? '' : 'disabled'}>ICS 저장하기</button>
            <div class="uri-tools-status" aria-live="polite"></div>
          </section>
          <section class="uri-tools-card">
            <h3>파일 가져오기와 위젯 설치</h3>
            <ul>
              <li><b>iPhone/iPad:</b> 다운로드한 .ics 파일을 열어 캘린더에 추가하세요. Safari·파일 앱에서 추가 메뉴가 안 보이면 본인에게 메일로 첨부한 뒤 Apple Mail의 첨부 파일에서 추가하거나, PC의 Google Calendar 웹에서 가져오세요. 이후 홈 화면을 길게 눌러 캘린더 위젯을 추가하세요.</li>
              <li><b>Android:</b> 삼성 캘린더 등 .ics 가져오기를 지원하는 앱에서 파일을 가져오세요. Google 캘린더는 PC 웹 가져오기가 필요할 수 있어요. 이후 홈 화면 위젯 목록에서 캘린더를 추가하세요.</li>
              <li>가져올 캘린더를 새로 만들어 두면 나중에 교체하거나 삭제하기 쉬워요.</li>
            </ul>
          </section>
          <section class="uri-tools-card">
            <h3>알림과 지원 차이</h3>
            <ul>
              <li>알림 허용, 배터리 절약, 집중 모드 설정에 따라 OS가 알림을 늦추거나 숨길 수 있어요.</li>
              <li>일부 캘린더 앱은 가져온 ICS의 알림을 무시하거나 자체 기본 알림으로 바꿀 수 있어요.</li>
              <li>이 방식은 한 번 가져오는 복사본이라 앱에서 수정한 내용이 자동 반영되지 않아요. 다시 내보내고 가져와야 하며 중복 일정이 생길 수 있어요.</li>
            </ul>
          </section>
          
          <section class="uri-tools-card">
            <h3>개인정보</h3>
            <p>ICS 생성은 브라우저 안에서만 처리합니다. 다만 저장한 파일에는 일정 제목, 시간, 메모가 들어가므로 파일 공유와 클라우드 백업 범위는 직접 확인해 주세요.</p>
          </section>
        </div>
      </section>`;
    document.body.appendChild(root);
    document.body.style.overflow = 'hidden';

    root.addEventListener('click', async event => {
      if (event.target.closest('[data-uri-close]')) return close();
      const exportButton = event.target.closest('[data-uri-export]');
      if (exportButton) {
        const status = root.querySelector('.uri-tools-status');
        const input = root.querySelector('#uri-tools-time');
        const reminderTime = VALID_TIME.test(input.value) ? input.value : '09:00';
        savePreferences({ reminderTime });
        try {
          const summary = downloadIcs(lastContext, { reminderTime });
          let message = `일정 ${summary.total}개와 알림 ${summary.alarms}개를 저장했어요.`;
          if (summary.adjusted) message += ` 시작 전으로 조정한 알림 ${summary.adjusted}개`;
          if (summary.crossedDay) message += `, 전날로 넘어간 알림 ${summary.crossedDay}개`;
          status.textContent = message;
        } catch (error) {
          status.textContent = error && error.message ? error.message : '파일을 만들지 못했어요.';
        }
        return;
      }
      const googleButton = event.target.closest('[data-uri-google]');
      if (googleButton) {
        const status = root.querySelector('.uri-tools-status');
        const hook = lastContext && lastContext.googleCalendar && typeof lastContext.googleCalendar.onConnect === 'function'
          ? lastContext.googleCalendar.onConnect : googleCalendarHook;
        if (!hook) {
          status.textContent = '달력을 새로 열어 다시 시도해 주세요.';
          return;
        }
        googleButton.disabled = true;
        try {
          await hook({ events: asArray(lastContext.events), settings: lastContext.settings || {}, source: 'uri-tools' });
          status.textContent = 'Google 캘린더 연결 화면을 열었어요.';
        } catch (error) {
          status.textContent = error && error.message ? error.message : 'Google 캘린더 연결을 시작하지 못했어요.';
        } finally {
          googleButton.disabled = false;
        }
      }
    });

    keyHandler = event => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', keyHandler);
    const closeButton = root.querySelector('.uri-tools-close');
    if (closeButton) closeButton.focus();
    return root;
  }

  function close() {
    if (keyHandler) document.removeEventListener('keydown', keyHandler);
    keyHandler = null;
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    if (document && document.body) document.body.style.overflow = '';
  }

  async function resolveContext() {
    if (typeof contextProvider === 'function') {
      const value = await contextProvider();
      if (value && typeof value === 'object') return value;
    }
    if (lastContext) return lastContext;
    let supplied = null;
    const detail = { open: value => { supplied = value; } };
    document.dispatchEvent(new CustomEvent('uri-tools-request-context', { detail }));
    return supplied || {};
  }

  async function delegatedOpen(event) {
    const button = event.target && event.target.closest ? event.target.closest('#calendar-tools-open') : null;
    if (!button) return;
    event.preventDefault();
    const context = await resolveContext();
    render(context);
  }

  document.addEventListener('click', delegatedOpen);

  const api = {
    version: VERSION,
    open(context) { return render(context || {}); },
    close,
    setContextProvider(provider) {
      if (provider !== null && typeof provider !== 'function') throw new TypeError('상태 공급자는 함수여야 해요.');
      contextProvider = provider;
      return api;
    },
    setGoogleCalendarHook(hook) {
      if (hook !== null && typeof hook !== 'function') throw new TypeError('Google 캘린더 훅은 함수여야 해요.');
      googleCalendarHook = hook;
      return api;
    },
    buildIcs,
    downloadIcs,
    test: Object.freeze({ normalizeEvent, resolveReminder, addDays, escapeIcs })
  };

  global.UriTools = api;
})(window);
