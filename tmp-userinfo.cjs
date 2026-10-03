// 临时排查（跑完即删）：解密 oauth:bigmodel:user_info / oauth:active_provider，
// 只打印字段名 + 掩码值（前 6 位 + 长度），定位桌面端 id.secret 签名对的来源。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const CRED_PATH = 'C:/Users/jianz/.zcode/v2/credentials.json';

function credentialSecret() {
  return `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`;
}

function decryptCredential(value) {
  const v = String(value ?? '');
  if (!v.startsWith('enc:v1:')) return v;
  const [ivRaw, tagRaw, dataRaw] = v.slice('enc:v1:'.length).split('.');
  const key = crypto.createHash('sha256').update(credentialSecret()).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

const raw = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));

function walk(obj, path) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const p = path ? `${path}.${k}` : k;
    if (v && typeof v === 'object') walk(v, p);
    else {
      const s = String(v ?? '');
      const looksKey = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}$/.test(s); // id.secret 形态
      console.log(`${p} = ${s.slice(0, 6)}…(${s.length}ch)${looksKey ? '  <-- id.secret 形态!' : ''}`);
    }
  }
}

for (const key of ['oauth:active_provider', 'oauth:bigmodel:user_info']) {
  console.log(`===== ${key} =====`);
  try {
    const dec = decryptCredential(raw[key]);
    walk(JSON.parse(dec), '');
  } catch (e) {
    console.log('解密/解析失败:', String(e.message).slice(0, 80));
  }
}
