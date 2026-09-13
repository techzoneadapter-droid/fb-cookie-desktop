const assert = require('node:assert/strict');
const { parseCookieText, extractCookieSegment } = require('../src/cookie-parser');

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

console.log('cookie-parser: all tests passed');
