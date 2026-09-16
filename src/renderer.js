const cookieInput = document.getElementById('cookieInput');
const loginBtn = document.getElementById('loginBtn');
const clearBtn = document.getElementById('clearBtn');
const fbLink = document.getElementById('fbLink');
const importBtn = document.getElementById('importBtn');
const startBatchBtn = document.getElementById('startBatchBtn');
const stopBatchBtn = document.getElementById('stopBatchBtn');
const fileInfo = document.getElementById('fileInfo');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const accountImportBtn = document.getElementById('accountImportBtn');
const accountStartBatchBtn = document.getElementById('accountStartBatchBtn');
const accountStopBatchBtn = document.getElementById('accountStopBatchBtn');
const accountFileInfo = document.getElementById('accountFileInfo');
const accountProgressBar = document.getElementById('accountProgressBar');
const accountProgressFill = document.getElementById('accountProgressFill');
const logArea = document.getElementById('logArea');
const tokenArea = document.getElementById('tokenArea');
const tokenCount = document.getElementById('tokenCount');
const copyLogBtn = document.getElementById('copyLogBtn');
const clearLogBtn = document.getElementById('clearLogBtn');
const copyTokensBtn = document.getElementById('copyTokensBtn');
const clearTokensBtn = document.getElementById('clearTokensBtn');
const statusEl = document.getElementById('status');
const uidValue = document.getElementById('uidValue');
const tokenValue = document.getElementById('tokenValue');
const secondWorkerToggle = document.getElementById('secondWorkerToggle');
const secondWorkerConfig = document.getElementById('secondWorkerConfig');
const secondWorkerUrl = document.getElementById('secondWorkerUrl');

const DEFAULT_FACEBOOK_ENTRY_URL = 'https://adsmanager.facebook.com/adsmanager/manage/campaigns/';

let selectedFilePath = null;
let selectedAccountFilePath = null;
let collectedTokens = [];

function saveParallelSettings() {
  try {
    localStorage.setItem('secondWorkerEnabled', String(secondWorkerToggle.checked));
    localStorage.setItem('secondWorkerUrl', secondWorkerUrl.value.trim());
  } catch (e) {}
}

function updateParallelSettingsVisibility() {
  secondWorkerConfig.hidden = !secondWorkerToggle.checked;
  secondWorkerUrl.disabled = !secondWorkerToggle.checked;
}

function setParallelControlsDisabled(disabled) {
  secondWorkerToggle.disabled = disabled;
  secondWorkerUrl.disabled = disabled || !secondWorkerToggle.checked;
}

function getBatchOptions() {
  const enabled = secondWorkerToggle.checked;
  const rawUrl = secondWorkerUrl.value.trim();
  if (!enabled) return { secondWorkerEnabled: false };

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    throw new Error('Link của luồng thứ 2 không hợp lệ');
  }
  const host = parsed.hostname.toLowerCase();
  const isFacebook = host === 'facebook.com' || host.endsWith('.facebook.com') ||
    host === 'fb.com' || host.endsWith('.fb.com');
  if (parsed.protocol !== 'https:' || !isFacebook) {
    throw new Error('Luồng thứ 2 chỉ chấp nhận link HTTPS thuộc Facebook');
  }
  return { secondWorkerEnabled: true, secondWorkerUrl: parsed.href };
}

try {
  secondWorkerToggle.checked = localStorage.getItem('secondWorkerEnabled') === 'true';
  secondWorkerUrl.value = localStorage.getItem('secondWorkerUrl') || DEFAULT_FACEBOOK_ENTRY_URL;
} catch (e) {}
updateParallelSettingsVisibility();
secondWorkerToggle.addEventListener('change', () => {
  updateParallelSettingsVisibility();
  saveParallelSettings();
});
secondWorkerUrl.addEventListener('change', saveParallelSettings);

function showStatus(message, type = 'info') {
  statusEl.textContent = message;
  statusEl.className = 'status show ' + type;
}

function appendLog(line) {
  logArea.value += (logArea.value ? '\n' : '') + line;
  logArea.scrollTop = logArea.scrollHeight;
}

function appendToken(token) {
  if (!token) return;
  collectedTokens.push(token);
  tokenArea.value += (tokenArea.value ? '\n' : '') + token;
  tokenArea.scrollTop = tokenArea.scrollHeight;
  tokenCount.textContent = collectedTokens.length;
}

function parseCookies(input) {
  return window.CookieParser.parseCookieText(input);
}

function isFacebookCookieDomain(domain) {
  const host = String(domain || '.facebook.com').trim().toLowerCase().replace(/^\.+/, '');
  return host === 'facebook.com' || host.endsWith('.facebook.com') ||
    host === 'fb.com' || host.endsWith('.fb.com');
}

document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const el = document.getElementById(btn.dataset.target);
    const text = el.dataset.full || el.textContent;
    if (!text || text === '—' || text === 'Chưa có') {
      showStatus('Không có dữ liệu', 'error');
      return;
    }
    await window.electronAPI.copyText(text);
    showStatus('Đã copy!', 'success');
  });
});

fbLink.addEventListener('click', async (e) => {
  e.preventDefault();
  await window.electronAPI.openFacebookExternal();
});

window.electronAPI.onStatusUpdate((data) => showStatus(data.message, data.type || 'info'));

window.electronAPI.onBatchStart((data) => {
  const accountMode = data.mode === 'account';
  collectedTokens = [];
  tokenArea.value = '';
  tokenCount.textContent = '0';
  appendLog('===== BẮT ĐẦU ' + (accountMode ? 'BATCH TÀI KHOẢN' : 'BATCH COOKIE') + ': ' + data.total +
    ' | ' + data.workerCount + ' LUỒNG =====');
  progressBar.classList.toggle('show', !accountMode);
  accountProgressBar.classList.toggle('show', accountMode);
  (accountMode ? accountProgressFill : progressFill).style.width = '0%';
  startBatchBtn.disabled = true;
  accountStartBatchBtn.disabled = true;
  stopBatchBtn.disabled = accountMode;
  accountStopBatchBtn.disabled = !accountMode;
  importBtn.disabled = true;
  accountImportBtn.disabled = true;
  setParallelControlsDisabled(true);
});

window.electronAPI.onBatchProgress((data) => {
  const pct = Math.round((data.current / data.total) * 100);
  (data.mode === 'account' ? accountProgressFill : progressFill).style.width = pct + '%';
  showStatus(data.message, 'info');
});

window.electronAPI.onBatchLine((data) => {
  appendLog(data.message);
});

window.electronAPI.onTokenObtained((data) => {
  appendToken(data.token);
});

window.electronAPI.onBatchDone((data) => {
  appendLog(data.stopped ? '===== ĐÃ DỪNG =====' : '===== HOÀN TẤT =====');
  appendLog(
    'Đã xử lý: ' + data.processed + '/' + data.total +
    ' | Đăng nhập được: ' + data.authenticated +
    ' | Có token: ' + data.success +
    ' | Thất bại: ' + data.fail
  );
  (data.mode === 'account' ? accountProgressFill : progressFill).style.width =
    Math.round((data.processed / data.total) * 100) + '%';
  startBatchBtn.disabled = !selectedFilePath;
  accountStartBatchBtn.disabled = !selectedAccountFilePath;
  stopBatchBtn.disabled = true;
  accountStopBatchBtn.disabled = true;
  importBtn.disabled = false;
  accountImportBtn.disabled = false;
  setParallelControlsDisabled(false);
  showStatus(
    (data.stopped ? 'Đã dừng' : 'Batch xong') + ': ' + data.authenticated + ' đăng nhập, ' + data.success + ' token',
    data.authenticated > 0 ? 'success' : 'error'
  );
});

loginBtn.addEventListener('click', async () => {
  const raw = cookieInput.value;
  if (!raw.trim()) { showStatus('Vui lòng dán cookie!', 'error'); return; }

  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="loading"></span>Đang xử lý...';

  try {
    const cookies = parseCookies(raw);
    if (cookies.length === 0) throw new Error('Cookie không hợp lệ hoặc không nhận diện được định dạng');
    const fbCookies = cookies.filter(c => isFacebookCookieDomain(c.domain));
    if (fbCookies.length === 0) throw new Error('Không có cookie Facebook');
    cookieInput.value = '';

    showStatus('Đang xác thực cookie với Facebook...', 'info');
    const result = await window.electronAPI.loginAndGetToken(fbCookies);

    if (result.authenticated) {
      uidValue.textContent = result.uid || '—';
      uidValue.title = result.uid || '';
      appendLog('[OK] Cookie đăng nhập được | UID: ' + (result.uid || 'N/A'));
      if (result.token) {
        tokenValue.textContent = result.token.length > 36 ? result.token.slice(0, 36) + '...' : result.token;
        tokenValue.dataset.full = result.token;
        tokenValue.title = result.token;
        appendToken(result.token);
        showStatus('Cookie đăng nhập thành công. Đã mở Ads Manager và lấy được token.', 'success');
      } else {
        tokenValue.textContent = 'Chưa tìm thấy';
        tokenValue.dataset.full = '';
        tokenValue.title = '';
        appendLog('[INFO] Đăng nhập được nhưng chưa tìm thấy Access Token');
        showStatus('Cookie đăng nhập thành công và Ads Manager đã mở; chưa tìm thấy Access Token.', 'success');
      }
    } else {
      uidValue.textContent = '—';
      uidValue.title = '';
      tokenValue.textContent = 'Không lấy được';
      tokenValue.dataset.full = '';
      tokenValue.title = '';
      appendLog('[FAIL] ' + (result.error || 'Cookie không đăng nhập được'));
      showStatus(result.error || 'Cookie không đăng nhập được', 'error');
    }
  } catch (err) {
    showStatus('Lỗi: ' + err.message, 'error');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Đăng nhập & Lấy Token';
  }
});

clearBtn.addEventListener('click', async () => {
  await window.electronAPI.clearFacebookCookies();
  uidValue.textContent = '—';
  tokenValue.textContent = 'Chưa có';
  tokenValue.dataset.full = '';
  showStatus('Đã xóa cookie', 'info');
});

importBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.selectCookieFile();
  if (!filePath) return;
  const parsed = await window.electronAPI.parseCookieFile(filePath);
  if (!parsed.success) {
    showStatus('Lỗi đọc file: ' + parsed.error, 'error');
    return;
  }
  selectedFilePath = filePath;
  const name = filePath.split(/[/\\]/).pop();
  fileInfo.textContent = name + ' → ' + parsed.validCount + ' cookie hợp lệ';
  startBatchBtn.disabled = parsed.count === 0;
  showStatus('Đã đọc file cookie: ' + parsed.validCount + ' mục hợp lệ', 'info');
});

startBatchBtn.addEventListener('click', async () => {
  if (!selectedFilePath) return;
  logArea.value = '';
  let options;
  try {
    options = getBatchOptions();
    saveParallelSettings();
  } catch (err) {
    showStatus(err.message, 'error');
    return;
  }
  const result = await window.electronAPI.startBatch(selectedFilePath, options);
  if (!result.success && result.error) {
    showStatus(result.error, 'error');
    startBatchBtn.disabled = !selectedFilePath;
    accountStartBatchBtn.disabled = !selectedAccountFilePath;
    stopBatchBtn.disabled = true;
    accountStopBatchBtn.disabled = true;
    importBtn.disabled = false;
    accountImportBtn.disabled = false;
    setParallelControlsDisabled(false);
  }
});

stopBatchBtn.addEventListener('click', async () => {
  await window.electronAPI.stopBatch();
  showStatus('Đang dừng batch cookie...', 'info');
});

accountImportBtn.addEventListener('click', async () => {
  const filePath = await window.electronAPI.selectAccountFile();
  if (!filePath) return;
  const parsed = await window.electronAPI.parseAccountFile(filePath);
  if (!parsed.success) {
    showStatus('Lỗi đọc file tài khoản: ' + parsed.error, 'error');
    return;
  }
  selectedAccountFilePath = filePath;
  const name = filePath.split(/[/\\]/).pop();
  accountFileInfo.textContent = name + ' → ' + parsed.count + ' dòng (' +
    parsed.validCount + ' có cookie, ' + parsed.invalidCount + ' lỗi)';
  accountStartBatchBtn.disabled = parsed.count === 0;
  showStatus('Đã đọc file tài khoản; mật khẩu, 2FA và mail không được lưu', 'info');
});

accountStartBatchBtn.addEventListener('click', async () => {
  if (!selectedAccountFilePath) return;
  logArea.value = '';
  let options;
  try {
    options = getBatchOptions();
    saveParallelSettings();
  } catch (err) {
    showStatus(err.message, 'error');
    return;
  }
  const result = await window.electronAPI.startAccountBatch(selectedAccountFilePath, options);
  if (!result.success && result.error) {
    showStatus(result.error, 'error');
    startBatchBtn.disabled = !selectedFilePath;
    accountStartBatchBtn.disabled = !selectedAccountFilePath;
    stopBatchBtn.disabled = true;
    accountStopBatchBtn.disabled = true;
    importBtn.disabled = false;
    accountImportBtn.disabled = false;
    setParallelControlsDisabled(false);
  }
});

accountStopBatchBtn.addEventListener('click', async () => {
  await window.electronAPI.stopAccountBatch();
  showStatus('Đang dừng batch tài khoản...', 'info');
});

copyLogBtn.addEventListener('click', async () => {
  if (!logArea.value) { showStatus('Log trống', 'error'); return; }
  await window.electronAPI.copyText(logArea.value);
  showStatus('Đã copy log', 'success');
});

clearLogBtn.addEventListener('click', () => { logArea.value = ''; });

copyTokensBtn.addEventListener('click', async () => {
  if (!tokenArea.value) { showStatus('Chưa có token', 'error'); return; }
  await window.electronAPI.copyText(tokenArea.value);
  showStatus('Đã copy ' + collectedTokens.length + ' token', 'success');
});

clearTokensBtn.addEventListener('click', () => {
  tokenArea.value = '';
  collectedTokens = [];
  tokenCount.textContent = '0';
});


// ===== UPDATE =====
const updateBtn = document.getElementById('updateBtn');
const versionLabel = document.getElementById('versionLabel');

(async () => {
  try {
    const v = await window.electronAPI.getAppVersion();
    if (versionLabel) versionLabel.textContent = 'v' + v;
  } catch (e) {}
})();

let updateState = 'idle'; // idle | available | downloading | downloaded

window.electronAPI.onUpdateStatus((data) => {
  showStatus(data.message, data.type === 'error' ? 'error' : 'info');
  if (data.type === 'available') {
    updateState = 'available';
    if (updateBtn) updateBtn.textContent = 'Tải v' + data.version;
  } else if (data.type === 'progress') {
    updateState = 'downloading';
    if (updateBtn) updateBtn.textContent = 'Đang tải ' + data.percent + '%';
  } else if (data.type === 'downloaded') {
    updateState = 'downloaded';
    if (updateBtn) updateBtn.textContent = 'Cài đặt ngay';
  } else if (data.type === 'not-available') {
    updateState = 'idle';
    if (updateBtn) updateBtn.textContent = 'Cập nhật';
  }
});

if (updateBtn) {
  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    try {
      if (updateState === 'idle' || updateState === 'available') {
        if (updateState === 'idle') {
          updateBtn.textContent = 'Đang kiểm tra...';
          const r = await window.electronAPI.checkForUpdate();
          showStatus(r.message, r.available ? 'info' : 'success');
          if (r.available) {
            updateState = 'available';
            updateBtn.textContent = 'Tải v' + r.version;
          } else {
            updateBtn.textContent = 'Cập nhật';
          }
        } else {
          // available → download
          updateBtn.textContent = 'Đang tải...';
          const r = await window.electronAPI.downloadUpdate();
          if (!r.success) {
            showStatus(r.message, 'error');
            updateBtn.textContent = 'Cập nhật';
            updateState = 'idle';
          }
        }
      } else if (updateState === 'downloaded') {
        await window.electronAPI.installUpdate();
      }
    } catch (err) {
      showStatus('Lỗi: ' + err.message, 'error');
      updateBtn.textContent = 'Cập nhật';
      updateState = 'idle';
    } finally {
      updateBtn.disabled = false;
    }
  });
}
