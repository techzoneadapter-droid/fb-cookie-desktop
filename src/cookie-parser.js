(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CookieParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_DOMAIN = '.facebook.com';
  const DEFAULT_EXPIRATION = () => Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90;
  const ATTRIBUTES = new Set([
    'domain', 'path', 'expires', 'max-age', 'secure', 'httponly',
    'samesite', 'priority', 'hostonly', 'session', 'storeid'
  ]);
  const JSON_METADATA = new Set([
    'uid', 'userid', 'user_id', 'timestamp', 'createdat', 'updatedat',
    'name', 'value', 'domain', 'path', 'secure', 'httponly', 'samesite',
    'expirationdate', 'expires', 'cookies', 'data', 'items', 'results'
  ]);

  function isCookieName(name) {
    return !!name && /^[^{}\s=;:]+$/.test(name);
  }

  function normalizeCookie(item, defaults) {
    if (!item || typeof item !== 'object') return null;
    const name = String(item.name ?? item.key ?? '').trim();
    const value = item.value ?? item.val ?? item.content;
    if (!isCookieName(name) || ATTRIBUTES.has(name.toLowerCase()) || value === undefined) return null;

    const expiration = Number(item.expirationDate ?? item.expires ?? 0);
    return {
      name,
      value: String(value).trim(),
      domain: String(item.domain || (defaults && defaults.domain) || DEFAULT_DOMAIN).trim() || DEFAULT_DOMAIN,
      path: String(item.path || (defaults && defaults.path) || '/'),
      secure: item.secure !== false,
      httpOnly: !!item.httpOnly,
      expirationDate: Number.isFinite(expiration) && expiration > 0 ? expiration : DEFAULT_EXPIRATION()
    };
  }

  function dedupe(cookies) {
    const map = new Map();
    for (const cookie of cookies) {
      if (!cookie) continue;
      const key = [cookie.name.toLowerCase(), cookie.domain, cookie.path].join('|');
      map.set(key, cookie);
    }
    return Array.from(map.values());
  }

  function appendJson(value, output, defaults) {
    if (Array.isArray(value)) {
      value.forEach(item => appendJson(item, output, defaults));
      return;
    }
    if (!value || typeof value !== 'object') return;

    const direct = normalizeCookie(value, defaults);
    if (direct) {
      output.push(direct);
      return;
    }

    for (const wrapper of ['cookies', 'data', 'items', 'results']) {
      if (value[wrapper] !== undefined) appendJson(value[wrapper], output, defaults);
    }

    // Hỗ trợ object dạng {"c_user":"123", "xs":"..."}.
    for (const [key, val] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (JSON_METADATA.has(lower) || val === null || typeof val === 'object') continue;
      const cookie = normalizeCookie({ name: key, value: val }, defaults);
      if (cookie) output.push(cookie);
    }
  }

  function parseCookieObject(value, defaults) {
    const output = [];
    appendJson(value, output, defaults);
    return dedupe(output);
  }

  function parsePairs(text, defaults) {
    const output = [];
    let source = String(text || '').trim().replace(/^Cookie\s*:\s*/i, '');
    if (!source) return output;

    for (let part of source.split(/[;\r\n]+/)) {
      part = part.trim();
      if (!part || part.startsWith('#')) continue;
      if (/^Set-Cookie\s*:/i.test(part)) part = part.replace(/^Set-Cookie\s*:\s*/i, '');

      let index = part.indexOf('=');
      if (index < 0 && part.includes('\t')) index = part.indexOf('\t');
      if (index < 0 && part.includes(':')) index = part.indexOf(':');
      if (index < 0) continue;

      const name = part.slice(0, index).trim().replace(/^['"]|['"]$/g, '');
      const value = part.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      const cookie = normalizeCookie({ name, value }, defaults);
      if (cookie) output.push(cookie);
    }
    return output;
  }

  function parseNetscape(lines) {
    const output = [];
    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
      let httpOnly = false;
      if (line.startsWith('#HttpOnly_')) {
        httpOnly = true;
        line = line.slice('#HttpOnly_'.length);
      }
      const fields = line.split('\t');
      if (fields.length < 7) continue;
      const expiration = Number(fields[4]);
      const cookie = normalizeCookie({
        name: fields[5], value: fields.slice(6).join('\t'), domain: fields[0],
        path: fields[2], secure: fields[3].toUpperCase() === 'TRUE',
        httpOnly, expirationDate: expiration
      });
      if (cookie) output.push(cookie);
    }
    return output;
  }

  function parseCookieText(input) {
    const raw = String(input ?? '').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];

    if (raw.startsWith('[') || raw.startsWith('{')) {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error('JSON cookie không hợp lệ');
      }
      const jsonCookies = parseCookieObject(parsed);
      if (jsonCookies.length) return jsonCookies;
    }

    const lines = raw.split(/\r?\n/);
    const hasNetscapeRows = lines.some(line => !line.trim().startsWith('#') && line.split('\t').length >= 7);
    if (hasNetscapeRows) return dedupe(parseNetscape(lines));

    const output = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      let candidate = trimmed;
      if (trimmed.includes('|')) {
        const parts = trimmed.split('|');
        candidate = parts.find(part => /(?:^|[;\s])(c_user|xs|fr|datr|sb)\s*=/i.test(part)) ||
          parts.find(part => part.includes('=') && part.includes(';')) || parts[parts.length - 1];
      }
      output.push(...parsePairs(candidate));
    }
    return dedupe(output);
  }

  return { parseCookieText, parseCookieObject, normalizeCookie };
});
