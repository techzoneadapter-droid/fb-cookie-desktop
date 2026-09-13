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

let selectedFilePath = null;
let collectedTokens = [];

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
  input = input.trim();
  if (!input) return [];
  if (input.startsWith('[') || input.startsWith('{')) {
    try {
      const parsed = JSON.parse(input);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.filter(c => c && c.name && c.value !== undefined).map(c => ({
        name: String(c.name).trim(),
        value: String(c.value).trim(),
        domain: c.domain || '.facebook.com',
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: !!c.httpOnly,
        expirationDate: c.expirationDate || (Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90)
      }));
    } catch (e) { throw new Error('JSON cookie không hợp lệ'); }
  }
  return input.split(';').map(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return null;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) return null;
    return {
      name, value, domain: '.facebook.com', path: '/',
      secure: true, httpOnly: false,
      expirationDate: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90
    };
  }).filter(Boolean);
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
  collectedTokens = [];
  tokenArea.value = '';
  tokenCount.textContent = '0';
  appendLog('===== BẮT ĐẦU BATCH: ' + data.total + ' cookie =====');
  progressBar.classList.add('show');
  progressFill.style.width = '0%';
  startBatchBtn.disabled = true;
  stopBatchBtn.disabled = false;
  importBtn.disabled = true;
});

window.electronAPI.onBatchProgress((data) => {
  const pct = Math.round((data.current / data.total) * 100);
  progressFill.style.width = pct + '%';
  showStatus(data.message, 'info');
});

window.electronAPI.onBatchLine((data) => {
  appendLog(data.message);
});

window.electronAPI.onTokenObtained((data) => {
  appendToken(data.token);
});

window.electronAPI.onBatchDone((data) => {
  appendLog('===== HOÀN TẤT =====');
  appendLog('Thành công: ' + data.success + ' | Thất bại: ' + data.fail + ' | Tổng: ' + data.total);
  progressFill.style.width = '100%';
  startBatchBtn.disabled = false;
  stopBatchBtn.disabled = true;
  importBtn.disabled = false;
  showStatus('Batch xong: ' + data.success + ' token lấy được', data.success > 0 ? 'success' : 'error');
});

loginBtn.addEventListener('click', async () => {
  const raw = cookieInput.value;
  if (!raw.trim()) { showStatus('Vui lòng dán cookie!', 'error'); return; }

  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="loading"></span>Đang xử lý...';

  try {
    const cookies = parseCookies(raw);
    if (cookies.length === 0) throw new Error('Cookie không hợp lệ');
    const fbCookies = cookies.filter(c => {
      const d = (c.domain || '').toLowerCase();
      return d.includes('facebook') || d.includes('fb.com') || !d;
    });
    if (fbCookies.length === 0) throw new Error('Không có cookie Facebook');

    showStatus('Đang chạy ngầm lấy token...', 'info');
    const result = await window.electronAPI.loginAndGetToken(fbCookies);

    if (result.success && result.token) {
      uidValue.textContent = result.uid || '—';
      uidValue.title = result.uid || '';
      tokenValue.textContent = result.token.length > 36 ? result.token.slice(0, 36) + '...' : result.token;
      tokenValue.dataset.full = result.token;
      tokenValue.title = result.token;
      appendLog('[OK] UID: ' + (result.uid || 'N/A'));
      appendToken(result.token);
      showStatus('Thành công! Token đã lấy được', 'success');
    } else {
      tokenValue.textContent = 'Không lấy được';
      tokenValue.dataset.full = '';
      appendLog('[FAIL] ' + (result.error || 'Cookie hết hạn'));
      showStatus(result.error || 'Cookie hết hạn / không lấy được token', 'error');
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
  fileInfo.textContent = name + ' → ' + parsed.count + ' cookie';
  startBatchBtn.disabled = parsed.count === 0;
  showStatus('Đã load ' + parsed.count + ' cookie từ file', 'info');
});

startBatchBtn.addEventListener('click', async () => {
  if (!selectedFilePath) return;
  logArea.value = '';
  const result = await window.electronAPI.startBatch(selectedFilePath);
  if (!result.success && result.error) {
    showStatus(result.error, 'error');
    startBatchBtn.disabled = false;
    stopBatchBtn.disabled = true;
    importBtn.disabled = false;
  }
});

stopBatchBtn.addEventListener('click', async () => {
  await window.electronAPI.stopBatch();
  showStatus('Đang dừng batch...', 'info');
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
