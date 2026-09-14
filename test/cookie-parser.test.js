const assert = require('node:assert/strict');
const {
  parseCookieText,
  extractCookieSegment,
  parseAccountCookieLine,
  parseAccountCookieFile
} = require('../src/cookie-parser');

function values(input) {
  return Object.fromEntries(parseCookieText(input).map(cookie => [cookie.name, cookie.value]));
}

assert.deepEqual(values(
  'wd=1000x1000; sb=V13QZxBl..., sb=MM56ZLSTISjO7srbMnnXh0OT; ' +
  'datr=LoQs..., datr=gxaDamvUHKPgaKIfZiL1SENK; wd=1000x1000; sb=NgF9Z,...'
), {
  wd: '1000x1000',
  sb: 'NgF9Z,...',
  datr: 'gxaDamvUHKPgaKIfZiL1SENK'
});

assert.deepEqual(values('Cookie: c_user=123; xs=abc%3Adef; fr=a=b=c'), {
  c_user: '123', xs: 'abc%3Adef', fr: 'a=b=c'
});
assert.deepEqual(values('c_user=123 xs=abc fr=hello'), {
  c_user: '123', xs: 'abc', fr: 'hello'
});
assert.deepEqual(values('c_user%3D123%3B%20xs%3Dabc'), {
  c_user: '123', xs: 'abc'
});
assert.deepEqual(values(JSON.stringify({
  cookies: [
    { name: 'c_user', value: '123', domain: '.facebook.com' },
    { name: 'xs', value: 'abc' }
  ]
})), { c_user: '123', xs: 'abc' });
assert.deepEqual(values(JSON.stringify({
  headers: { cookie: 'c_user=123; xs=abc' }
})), { c_user: '123', xs: 'abc' });
assert.deepEqual(values(JSON.stringify({
  request: {
    headers: [
      { name: 'accept', value: '*/*' },
      { name: 'cookie', value: 'c_user=123; xs=abc' }
    ]
  }
})), { c_user: '123', xs: 'abc' });
assert.deepEqual(values('Set-Cookie: c_user=123; Path=/, Set-Cookie: xs=abc; HttpOnly'), {
  c_user: '123', xs: 'abc'
});
assert.deepEqual(values('c_user=123; optional='), { c_user: '123', optional: '' });
assert.deepEqual(values('name,value,domain\nc_user,123,.facebook.com\nxs,abc,.facebook.com'), {
  c_user: '123', xs: 'abc'
});
assert.deepEqual(values('.facebook.com\tTRUE\t/\tTRUE\t1999999999\tc_user\t123'), {
  c_user: '123'
});
const accountPasswordCookieLine = '2168997796|not-a-cookie-password|ps\\_l=1; ps\\_n=1; dbln=%7B%22id%22%3A%22value%22%7D; datr=device-value';
assert.equal(extractCookieSegment(accountPasswordCookieLine), 'ps\\_l=1; ps\\_n=1; dbln=%7B%22id%22%3A%22value%22%7D; datr=device-value');
assert.deepEqual(values(accountPasswordCookieLine), {
  ps_l: '1', ps_n: '1', dbln: '%7B%22id%22%3A%22value%22%7D', datr: 'device-value'
});
assert.deepEqual(values('account@example.test|password=never-import-this|c_user=123; xs=session-value'), {
  c_user: '123', xs: 'session-value'
});

const accountWith2fa = parseAccountCookieLine(
  '100012345678901|secret-password|PY4KOGOYWT72H36YJQQYFKPYXFGGBVEW|c_user=100012345678901; xs=session-value; fr=tracking'
);
assert.equal(accountWith2fa.recognized, true);
assert.equal(accountWith2fa.uid, '100012345678901');
assert.deepEqual(Object.keys(accountWith2fa).sort(), ['cookies', 'hasCookie', 'recognized', 'uid']);
assert.deepEqual(Object.fromEntries(accountWith2fa.cookies.map(cookie => [cookie.name, cookie.value])), {
  c_user: '100012345678901', xs: 'session-value', fr: 'tracking'
});

const accountWithMail = parseAccountCookieLine(
  '100012345678902|secret-password|PY4KOGOYWT72H36YJQQYFKPYXFGGBVEW|owner@example.test|datr=device; c_user=100012345678902; xs=second-session'
);
assert.equal(accountWithMail.recognized, true);
assert.equal(accountWithMail.uid, '100012345678902');
assert.deepEqual(Object.fromEntries(accountWithMail.cookies.map(cookie => [cookie.name, cookie.value])), {
  datr: 'device', c_user: '100012345678902', xs: 'second-session'
});

const accountWithoutCookie = parseAccountCookieLine(
  '100012345678903|secret-password|PY4KOGOYWT72H36YJQQYFKPYXFGGBVEW|owner@example.test'
);
assert.equal(accountWithoutCookie.recognized, true);
assert.equal(accountWithoutCookie.hasCookie, false);
assert.deepEqual(accountWithoutCookie.cookies, []);

const accountFile = parseAccountCookieFile([
  '# ignored comment',
  '100012345678901|secret-password|PY4KOGOYWT72H36YJQQYFKPYXFGGBVEW|c_user=100012345678901; xs=session-value',
  'not-an-account-line',
  '100012345678903|secret-password|PY4KOGOYWT72H36YJQQYFKPYXFGGBVEW|owner@example.test'
].join('\n'));
assert.equal(accountFile.length, 3);
assert.deepEqual(accountFile.map(item => item.type), [
  'account-cookie', 'invalid-account-format', 'invalid-account'
]);
assert.equal(JSON.stringify(accountFile).includes('secret-password'), false);
assert.equal(JSON.stringify(accountFile).includes('PY4KOGOYWT72H36YJQQYFKPYXFGGBVEW'), false);

console.log('cookie-parser: all tests passed');
