export const CONN_BANNER_CONNECTING_DELAY_MS = 800;
export const CONN_BANNER_DISCONNECT_DELAY_MS = 1000;
export const CONN_BANNER_RETRY_DELAY_MS = 5000;
export const CONN_BANNER_RECONNECTED_LINGER_MS = 1600;

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function resolveConnectionBanner({
  phase,
  elapsedMs,
  suppressed = false,
  wasVisible = false,
} = {}) {
  if (suppressed) return null;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;

  if (phase === 'connecting') {
    if (elapsedMs < CONN_BANNER_CONNECTING_DELAY_MS) return null;
    return {
      tone: 'info',
      label: '连接中…',
      detail: '',
      spinner: true,
      retry: elapsedMs >= CONN_BANNER_RETRY_DELAY_MS,
    };
  }

  if (phase === 'offline') {
    if (elapsedMs < CONN_BANNER_DISCONNECT_DELAY_MS) return null;
    return {
      tone: 'warn',
      label: '连接断开，自动重连中…',
      detail: `已断开 ${formatElapsed(elapsedMs)}`,
      spinner: true,
      retry: elapsedMs >= CONN_BANNER_RETRY_DELAY_MS,
    };
  }

  if (phase === 'online') {
    if (!wasVisible || elapsedMs >= CONN_BANNER_RECONNECTED_LINGER_MS) return null;
    return {
      tone: 'success',
      label: '已重新连接',
      detail: '',
      spinner: false,
      retry: false,
    };
  }

  return null;
}
