// e2ee.js —— 端到端加密传输层。
// X25519 ECDH 密钥协商 + Ed25519 身份签名 + AES-256-GCM 对称加密 + HKDF-SHA256 派生。
// 设计参考 Remodex secure-transport.js（Apache-2.0），纯 Node crypto，零第三方依赖。
//
// 4 步握手：
//   ClientHello → ServerHello → ClientAuth → SecureReady
//
// 加密信封：{ ct: "<base64 ciphertext>", iv: "<base64 nonce>" }
// nonce = 12 字节：方向位(1) + 单调 counter(11)，防重放。

import {
  generateKeyPairSync,
  createPublicKey,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  diffieHellman,
} from 'node:crypto';
import { sign as _sign, verify as _verify } from 'node:crypto';

// ---- 常量 ----
const AES_GCM_KEY_LEN = 32;    // AES-256
const AES_GCM_IV_LEN = 12;     // GCM 推荐 nonce 长度
const AES_GCM_TAG_LEN = 16;    // GCM 认证标签
const X25519_PUB_LEN = 32;
const ED25519_PUB_LEN = 32;
const ED25519_SIG_LEN = 64;
const COUNTER_LEN = 11;
const DIRECTION_BIT = { CLIENT_TO_SERVER: 0, SERVER_TO_CLIENT: 1 };

// ---- 长期身份密钥 ----
export function generateIdentityKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // 导出 public key 为 raw 32 字节用于传输
  const publicKeyRaw = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: publicKeyRaw, privateKey };
}

// ---- 临时 ECDH 密钥对 ----
export function generateEphemeralKeyPair() {
  // X25519：返回 KeyObject（raw），用于 diffieHellman
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  // 导出 public key 为 raw 32 字节用于传输
  const publicKeyRaw = publicKey.export({ type: 'spki', format: 'der' });
  return { publicKey: publicKeyRaw, privateKey };
}

// 计算 X25519 共享密钥
export function computeSharedSecret(myPrivateKey, peerPublicKeyRaw) {
  // peerPublicKey 是 DER SPKI 格式，需要转回 KeyObject 或 raw
  const peerKey = createPublicKey({
    key: peerPublicKeyRaw,
    format: 'der',
    type: 'spki',
  });
  return diffieHellman({
    privateKey: myPrivateKey,
    publicKey: peerKey,
  });
}

// ---- HKDF 派生 ----
function hkdfDerive(ikm, salt, info, length = AES_GCM_KEY_LEN) {
  return hkdfSync('sha256', ikm, salt, info, length);
}

// ---- 对称加密 / 解密 ----
export function encrypt(key, plaintext, counter, direction) {
  const iv = buildNonce(direction, counter);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AES_GCM_TAG_LEN });
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 将 tag 附加到密文末尾
  const result = Buffer.concat([ct, tag]);
  return result.toString('base64');
}

export function decrypt(key, base64Ct, counter, direction) {
  const iv = buildNonce(direction, counter);
  const raw = Buffer.from(base64Ct, 'base64');
  if (raw.length < AES_GCM_TAG_LEN) throw new Error('ciphertext too short');
  const ct = raw.subarray(0, raw.length - AES_GCM_TAG_LEN);
  const tag = raw.subarray(raw.length - AES_GCM_TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AES_GCM_TAG_LEN });
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

function buildNonce(direction, counter) {
  const buf = Buffer.alloc(AES_GCM_IV_LEN);
  buf.writeUInt8(direction ? 1 : 0, 0);
  buf.writeBigUInt64BE(BigInt(counter), 3);
  return buf;
}

// ---- 签名 / 验签 ----
// Ed25519 使用 crypto.sign / crypto.verify（内建 SHA-512）
export function sign(privateKey, data) {
  return _sign(null, data, privateKey);
}

export function verify(publicKeyDer, data, signature) {
  const pubKey = createPublicKey({
    key: publicKeyDer,
    format: 'der',
    type: 'spki',
  });
  return _verify(null, data, pubKey, signature);
}

// ---- 握手状态机 ----
export class E2EEHandshake {
  // server 侧
  constructor({ isServer, identityKeyPair }) {
    this.isServer = isServer;
    this.identityKeyPair = identityKeyPair; // 长期 Ed25519 密钥对

    this.ephKeyPair = null;   // 临时 X25519
    this.sharedSecret = null; // 派生对称密钥
    this.peerEphPub = null;   // 对方临时公钥
    this.peerIdentityPub = null; // 对方长期公钥

    this.sendCounter = 0;
    this.recvCounter = 0;
    // 方向：send = 我的方向位，recv = 对方的方向位
    if (isServer) {
      this.sendDir = DIRECTION_BIT.SERVER_TO_CLIENT;
      this.recvDir = DIRECTION_BIT.CLIENT_TO_SERVER;
    } else {
      this.sendDir = DIRECTION_BIT.CLIENT_TO_SERVER;
      this.recvDir = DIRECTION_BIT.SERVER_TO_CLIENT;
    }
    this.ready = false;
  }

  // 客户端发起：生成临时密钥，输出 ClientHello
  startClientHello() {
    this.ephKeyPair = generateEphemeralKeyPair();
    return {
      type: 'clientHello',
      ephPub: this.ephKeyPair.publicKey.toString('base64'),
    };
  }

  // 服务端处理 ClientHello → ServerHello
  handleClientHello(msg) {
    this.ephKeyPair = generateEphemeralKeyPair();
    this.peerEphPub = Buffer.from(msg.ephPub, 'base64');

    // DH 派生共享密钥
    this.sharedSecret = hkdfDerive(
      computeSharedSecret(this.ephKeyPair.privateKey, this.peerEphPub),
      Buffer.from('codex-chat-mobile-v1'),
      Buffer.from('session-key')
    );

    return {
      type: 'serverHello',
      ephPub: this.ephKeyPair.publicKey.toString('base64'),
      identityPub: this.identityKeyPair.publicKey.toString('base64'),
    };
  }

  // 客户端处理 ServerHello → ClientAuth
  handleServerHello(msg) {
    this.peerEphPub = Buffer.from(msg.ephPub, 'base64');
    this.peerIdentityPub = Buffer.from(msg.identityPub, 'base64');

    this.sharedSecret = hkdfDerive(
      computeSharedSecret(this.ephKeyPair.privateKey, this.peerEphPub),
      Buffer.from('codex-chat-mobile-v1'),
      Buffer.from('session-key')
    );

    // 签名握手记录
    const handshakeData = Buffer.concat([
      this.ephKeyPair.publicKey,
      this.peerEphPub
    ]);
    const sig = sign(this.identityKeyPair.privateKey, handshakeData);

    return {
      type: 'clientAuth',
      identityPub: this.identityKeyPair.publicKey.toString('base64'),
      signature: sig.toString('base64'),
    };
  }

  // 服务端处理 ClientAuth → SecureReady
  handleClientAuth(msg) {
    this.peerIdentityPub = Buffer.from(msg.identityPub, 'base64');
    const signature = Buffer.from(msg.signature, 'base64');

    const handshakeData = Buffer.concat([
      this.peerEphPub,
      this.ephKeyPair.publicKey,
    ]);

    if (!verify(this.peerIdentityPub, handshakeData, signature)) {
      throw new Error('E2EE: clientAuth signature verification failed');
    }

    this.ready = true;
    return { type: 'secureReady' };
  }

  // 客户端标记 ready
  markReady() {
    this.ready = true;
  }

  // ---- 加密通信 ----
  send(plaintext) {
    if (!this.ready) throw new Error('E2EE: not ready');
    return encrypt(this.sharedSecret, plaintext, this.sendCounter++, this.sendDir);
  }

  recv(ciphertext) {
    if (!this.ready) throw new Error('E2EE: not ready');
    return decrypt(this.sharedSecret, ciphertext, this.recvCounter++, this.recvDir);
  }
}

// 服务端侧便捷函数
export function serverSend(handshake, plaintext) {
  return encrypt(handshake.sharedSecret, plaintext, handshake.sendCounter++, DIRECTION_BIT.SERVER_TO_CLIENT);
}

export function serverRecv(handshake, ciphertext) {
  return decrypt(handshake.sharedSecret, ciphertext, handshake.recvCounter++, DIRECTION_BIT.CLIENT_TO_SERVER);
}
