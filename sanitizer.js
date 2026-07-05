// sanitizer.js —— 日志脱敏模块
// 功能：过滤日志/终端输出中的敏感信息（token、API key、密码等），防止泄露。

const PATTERNS = [
  [/\b(sk|key|api)[-_][A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g, '***'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, '***'],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, '***'],
  [/Bearer\s+[A-Za-z0-9._\-]{20,}/g, 'Bearer ***'],
  [/([A-Z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z_]*\s*=\s*)\S+/g, '$1***'],
  [/([A-Za-z_]*(key|secret|token|password|passwd|credential)[A-Za-z_]*\s*=\s*)\S{8,}/gi, '$1***'],
  [/\b(aws_session_token|AWS_SESSION_TOKEN)\s*=\s*\S+/gi, '***'],
  [/\b(access_token|refresh_token)[:=]\s*[A-Za-z0-9._\-]{20,}\b/g, '$1:***'],
  [/\b[0-9a-f]{2}(:[0-9a-f]{2}){15,}\b/g, '***'],
  [/\b([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/g, '$1***$2'],
  [/(?:Basic\s+)[A-Za-z0-9+/=]{8,}/gi, 'Basic ***'],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '***'],
  [/\b(bot)?\d{6,}(?::|%3[Aa])[A-Za-z0-9_-]{20,}\b/g, '***'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '***'],
];

const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripControlSequences(text) {
  if (typeof text !== 'string') return '';
  text = text.replace(ANSI_ESCAPE_RE, '');
  text = text.replace(CONTROL_CHARS_RE, '');
  return text;
}

export function sanitize(text) {
  if (typeof text !== 'string') return '';
  text = stripControlSequences(text);
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function maskToken(token) {
  if (!token || typeof token !== 'string') return '***';
  if (token.length < 12) return '***';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

export function sanitizePath(path) {
  if (typeof path !== 'string') return '';
  const replacements = [
    [/\/Users\/[^/]+/g, '<home>'],
    [/\/home\/[^/]+/g, '<home>'],
    [/C:\\Users\\[^\\]+/gi, '<home>'],
    [/\/tmp\//g, '<tmp>/'],
    [/\/var\//g, '<var>/'],
    [/C:\\Windows\\/gi, '<windows>\\'],
    [/C:\\Program Files/gi, '<program-files>'],
  ];
  for (const [pattern, replacement] of replacements) {
    path = path.replace(pattern, replacement);
  }
  return path;
}
