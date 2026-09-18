/**
 * 生成 manifest.json 用的扩展公钥（"key"）并算出对应的固定扩展 ID。
 *
 * 为什么要有 key：不填 key 时，Chrome 用「目录绝对路径」派生扩展 ID，
 * 换个目录/换个机器 ID 就变了，chrome.storage 里的缓存与设置会跟着“丢失”。
 * 填了 key 之后 ID 固定，也方便把无头浏览器直接指向某个扩展页面做冒烟测试。
 *
 * 用法：node tools/gen-key.mjs
 */

import { generateKeyPairSync, createHash } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const keyB64 = publicKey.toString('base64');
const digest = createHash('sha256').update(publicKey).digest().subarray(0, 16);
const id = [...digest].map((b) => 'abcdefghijklmnop'[b >> 4] + 'abcdefghijklmnop'[b & 15]).join('');

console.log('扩展 ID:', id);
console.log('manifest 里的 "key" 字段值（一行）：');
console.log(keyB64);
console.log('\n对应的私钥（只在需要给 crx 签名时才用得着，不要提交到仓库）：');
console.log(privateKey);
