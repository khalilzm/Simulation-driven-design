import { Cursor } from '@cursor/sdk';

const status = await Cursor.auth.status();
if (status.status === 'logged-in') {
  console.log('已登录', status.email ? `(${status.email})` : '');
  process.exit(0);
}

console.log('正在打开浏览器，请用 Cursor 账号登录…');
const result = await Cursor.auth.login({
  onLoginUrl: (url) => console.log('登录链接:', url),
});
console.log('登录成功', result.email ? `(${result.email})` : '');
console.log('凭证已保存到 ~/.cursor/sdk/auth.json，有效期至', new Date(result.apiKeyExpiresAtMs).toLocaleString());
