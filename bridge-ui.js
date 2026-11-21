/*
 * 개인 Google Apps Script 자동 모드 설정 UI
 *
 * 제공 API:
 *   window.UriBridge.open({ dbUrl, code, me })
 *
 * 사용자가 본인을 직접 선택하고 복사 버튼을 누르기 전에는 아무 URL에도 접속하지 않습니다.
 * 복사 시 같은 폴더의 bridge.gs.txt만 읽어 현재 방 설정을 넣고 클립보드로 복사합니다.
 * 운영 데이터, Google Calendar, Firebase에는 이 파일이 직접 접속하지 않습니다.
 */
(function (global) {
  'use strict';

  var STYLE_ID = 'uri-bridge-style';
  var root = null;

  function node(tag, attrs, text) {
    var out = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'class') out.className = attrs[key];
      else if (key === 'for') out.htmlFor = attrs[key];
      else out[key] = attrs[key];
    });
    if (text != null) out.textContent = text;
    return out;
  }

  function validDbUrl(value) {
    return /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:firebaseio\.com|firebasedatabase\.app)\/?$/i.test(String(value || '').trim());
  }

  function validCode(value) { return /^[a-z0-9]{12,40}$/.test(String(value || '').trim()); }
  function validTime(value) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')); }

  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = node('style', { id: STYLE_ID });
    style.textContent = [
      '.urb-back{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.44);display:flex;align-items:flex-end;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#202124}',
      '.urb-sheet{box-sizing:border-box;width:min(100%,560px);max-height:92vh;overflow:auto;background:#fff;border-radius:18px 18px 0 0;padding:9px 18px calc(22px + env(safe-area-inset-bottom,0px));box-shadow:0 -8px 30px rgba(0,0,0,.2)}',
      '.urb-grab{width:38px;height:5px;border-radius:4px;background:#d8dbe0;margin:0 auto 12px}.urb-head{display:flex;align-items:center;gap:10px}.urb-head h2{font-size:20px;margin:0;flex:1}.urb-close{border:0;background:none;font-size:26px;color:#6a6f76;padding:3px 8px}',
      '.urb-lead{font-size:14px;line-height:1.55;color:#555;margin:8px 0 13px}.urb-card{border:1px solid #e2e4e8;border-radius:14px;padding:14px;margin:10px 0}.urb-card h3{font-size:15px;margin:0 0 8px}.urb-card ol{padding-left:20px;margin:6px 0}.urb-card li,.urb-note{font-size:13px;line-height:1.55;color:#60656d}',
      '.urb-label{display:block;font-size:12px;font-weight:750;color:#73777e;margin:11px 0 6px}.urb-input,.urb-select{box-sizing:border-box;width:100%;border:1px solid #d9dce1;border-radius:10px;background:#fff;padding:11px 12px;font:inherit;font-size:16px;color:#202124}.urb-input[readonly]{background:#f5f6f8;color:#666}',
      '.urb-row{display:flex;gap:9px}.urb-row>div{flex:1;min-width:0}.urb-check{display:flex;align-items:flex-start;gap:9px;font-size:13px;line-height:1.5;margin:13px 0}.urb-check input{width:18px;height:18px;flex:none}',
      '.urb-btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.urb-btn{border:0;border-radius:11px;background:#f0f1f3;padding:12px 14px;font:inherit;font-weight:750;color:#202124;text-decoration:none;cursor:pointer}.urb-btn.primary{background:#202124;color:#fff;flex:1}.urb-btn:disabled{opacity:.45;cursor:default}',
      '.urb-msg{font-size:13px;line-height:1.5;border-radius:10px;background:#f4f5f7;color:#555;padding:10px 12px;margin-top:10px;white-space:pre-wrap}.urb-msg.ok{background:#e9f6ed;color:#176b35}.urb-msg.err{background:#fcebea;color:#a82420}',
      '.urb-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.4px}.urb-small{font-size:12px;line-height:1.55;color:#7c8188;margin:10px 1px}'
    ].join('');
    document.head.appendChild(style);
  }

  function close() {
    if (root) root.remove();
    root = null;
  }

  function setMessage(box, text, kind) {
    box.textContent = text;
    box.className = 'urb-msg' + (kind ? ' ' + kind : '');
  }

  async function copyText(text) {
    if (navigator.clipboard && global.isSecureContext) return navigator.clipboard.writeText(text);
    var area = node('textarea', { value: text, readOnly: true });
    area.style.position = 'fixed'; area.style.opacity = '0'; area.style.pointerEvents = 'none';
    document.body.appendChild(area); area.select();
    var ok = document.execCommand('copy'); area.remove();
    if (!ok) throw new Error('클립보드 복사를 지원하지 않는 브라우저입니다.');
  }

  async function customizedScript(dbUrl, code, me, notificationTime) {
    var response = await fetch('bridge.gs.txt', { method: 'GET', cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('bridge.gs.txt를 읽지 못했습니다 (HTTP ' + response.status + ').');
    var script = await response.text();
    if (script.indexOf('__URI_DB_URL__') < 0 || script.indexOf('__URI_ROOM_CODE__') < 0 || script.indexOf('__URI_ME__') < 0) {
      throw new Error('bridge.gs.txt 템플릿 표식을 찾지 못했습니다.');
    }
    return script.split('__URI_DB_URL__').join(dbUrl.replace(/\/+$/, ''))
      .split('__URI_ROOM_CODE__').join(code)
      .split('__URI_ME__').join(me)
      .replace("notificationTime: '09:05'", "notificationTime: '" + notificationTime + "'");
  }

  function open(options) {
    options = options || {};
    close();
    installStyle();

    var dbUrl = String(options.dbUrl || '').trim();
    var code = String(options.code || '').trim();
    var suggestedMe = options.me === 'a' || options.me === 'b' ? options.me : '';

    root = node('div', { class: 'urb-back', role: 'dialog', ariaModal: 'true', ariaLabel: '개인 Google Calendar 자동 모드' });
    var sheet = node('section', { class: 'urb-sheet' });
    sheet.appendChild(node('div', { class: 'urb-grab' }));
    var head = node('div', { class: 'urb-head' });
    head.appendChild(node('h2', {}, '개인 Google Calendar 자동 모드'));
    var closeButton = node('button', { class: 'urb-close', type: 'button', ariaLabel: '닫기' }, '×');
    closeButton.addEventListener('click', close);
    head.appendChild(closeButton);
    sheet.appendChild(head);
    sheet.appendChild(node('p', { class: 'urb-lead' }, '두 사람은 각자 자신의 Google 계정에서 따로 설정합니다. 공유 방 events만 전용 캘린더로 복사하며 기본 캘린더 일정은 읽지 않습니다.'));

    var config = node('section', { class: 'urb-card' });
    config.appendChild(node('h3', {}, '1. 본인과 알림 시각 확인'));
    var dbInput = node('input', { class: 'urb-input', value: dbUrl, readOnly: true, ariaLabel: '데이터베이스 주소' });
    config.appendChild(node('label', { class: 'urb-label' }, '현재 공유 데이터베이스'));
    config.appendChild(dbInput);
    var masked = code ? code.slice(0, 4) + '••••••••' + code.slice(-4) : '';
    var codeInput = node('input', { class: 'urb-input urb-code', value: masked, readOnly: true, ariaLabel: '공유 방 코드 일부' });
    config.appendChild(node('label', { class: 'urb-label' }, '현재 공유 방 코드 (일부만 표시)'));
    config.appendChild(codeInput);

    var row = node('div', { class: 'urb-row' });
    var meWrap = node('div');
    meWrap.appendChild(node('label', { class: 'urb-label' }, '나는 누구인가요?'));
    var meSelect = node('select', { class: 'urb-select', ariaLabel: '본인 선택' });
    meSelect.appendChild(node('option', { value: '' }, suggestedMe ? '직접 선택 (현재 앱: ' + suggestedMe.toUpperCase() + ')' : '직접 선택'));
    meSelect.appendChild(node('option', { value: 'a' }, '나는 A'));
    meSelect.appendChild(node('option', { value: 'b' }, '나는 B'));
    meWrap.appendChild(meSelect);
    row.appendChild(meWrap);
    var timeWrap = node('div');
    timeWrap.appendChild(node('label', { class: 'urb-label' }, '오늘 알림 시각'));
    var timeInput = node('input', { class: 'urb-input', type: 'time', value: '09:05', ariaLabel: '오늘 알림 시각' });
    timeWrap.appendChild(timeInput);
    row.appendChild(timeWrap);
    config.appendChild(row);
    config.appendChild(node('p', { class: 'urb-note' }, '알림 시각에 5분짜리 비공개 일정을 만들고 5분 전 Google Calendar 팝업을 보냅니다. 종일 일정도 포함합니다. 휴대폰에서 전용 캘린더 알림이 허용되어 있어야 합니다.'));

    var consentLabel = node('label', { class: 'urb-check' });
    var consent = node('input', { type: 'checkbox' });
    consentLabel.appendChild(consent);
    consentLabel.appendChild(node('span', {}, '내가 선택한 개인 Google 계정에 전용 캘린더를 만들고, 현재 공유 방 events를 15분마다 단방향 복사하는 설정을 직접 실행하겠습니다.'));
    config.appendChild(consentLabel);
    var copyButton = node('button', { class: 'urb-btn primary', type: 'button' }, '내 설정이 포함된 스크립트 복사');
    config.appendChild(copyButton);
    sheet.appendChild(config);

    var guide = node('section', { class: 'urb-card' });
    guide.appendChild(node('h3', {}, '2. 개인 Apps Script에서 한 번 실행'));
    var steps = node('ol');
    ['아래 버튼으로 Apps Script 새 프로젝트를 엽니다.', 'Code.gs의 내용을 모두 지우고 복사한 스크립트를 붙여넣은 뒤 저장합니다.', '프로젝트 설정에서 시간대를 Asia/Seoul로 지정합니다.', '왼쪽 서비스 +에서 Calendar API를 추가합니다. 403 오류가 나면 이 단계를 다시 확인합니다.', '상단 함수 목록에서 setupUriBridge를 골라 실행하고 본인 Google 권한을 승인합니다.', '휴대폰 Google Calendar에서 새 전용 캘린더를 표시하고 알림을 허용합니다.'].forEach(function (text) { steps.appendChild(node('li', {}, text)); });
    guide.appendChild(steps);
    var buttons = node('div', { class: 'urb-btns' });
    buttons.appendChild(node('a', { class: 'urb-btn', href: 'https://script.google.com/home/projects/create', target: '_blank', rel: 'noopener noreferrer' }, 'Apps Script 새 프로젝트'));
    var copySetup = node('button', { class: 'urb-btn', type: 'button' }, '실행 함수명 복사');
    buttons.appendChild(copySetup);
    guide.appendChild(buttons);
    sheet.appendChild(guide);

    var message = node('div', { class: 'urb-msg' }, '아직 아무 데이터에도 접속하지 않았습니다. 본인을 직접 선택한 뒤 복사하세요.');
    sheet.appendChild(message);
    sheet.appendChild(node('p', { class: 'urb-small' }, '중지: Apps Script에서 stopUriBridge() 실행. 재개: setupUriBridge() 실행. 완전 제거: removeUriBridgeData(true) 실행. 관리자 키, 웹 앱 배포, 이메일 권한은 사용하지 않습니다.'));

    copyButton.addEventListener('click', async function () {
      var me = meSelect.value;
      var notificationTime = timeInput.value;
      if (!validDbUrl(dbUrl) || !validCode(code)) return setMessage(message, '현재 공유 연결 정보가 없거나 형식이 올바르지 않습니다.', 'err');
      if (me !== 'a' && me !== 'b') return setMessage(message, '본인을 A 또는 B로 직접 선택해 주세요.', 'err');
      if (!validTime(notificationTime)) return setMessage(message, '오늘 알림 시각을 확인해 주세요.', 'err');
      if (!consent.checked) return setMessage(message, '설정 내용을 확인하고 동의 체크를 해 주세요.', 'err');
      copyButton.disabled = true;
      setMessage(message, 'bridge.gs.txt를 읽어 내 설정을 넣고 있습니다...');
      try {
        var script = await customizedScript(dbUrl, code, me, notificationTime);
        await copyText(script);
        setMessage(message, '스크립트를 복사했습니다. Apps Script의 Code.gs에 붙여넣고 setupUriBridge를 한 번 실행하세요.', 'ok');
      } catch (err) {
        setMessage(message, err && err.message ? err.message : '스크립트를 복사하지 못했습니다.', 'err');
      } finally { copyButton.disabled = false; }
    });

    copySetup.addEventListener('click', function () {
      copyText('setupUriBridge').then(function () { setMessage(message, '실행 함수명 setupUriBridge를 복사했습니다.', 'ok'); })
        .catch(function (err) { setMessage(message, err.message || '복사하지 못했습니다.', 'err'); });
    });

    root.addEventListener('click', function (event) { if (event.target === root) close(); });
    root.addEventListener('keydown', function (event) { if (event.key === 'Escape') close(); });
    root.appendChild(sheet);
    document.body.appendChild(root);
    closeButton.focus();
    return { close: close };
  }

  global.UriBridge = Object.freeze({ open: open, close: close, version: '1.0.0' });
})(window);
