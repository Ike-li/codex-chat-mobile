function revision(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function applyThreadStatus(threads, change) {
  if (!Array.isArray(threads) || !change?.threadId || !change?.status) {
    return Array.isArray(threads) ? threads : [];
  }
  const incomingRevision = revision(change.revision);
  return threads.map(thread => {
    if (thread?.id !== change.threadId) return thread;
    const currentRevision = revision(thread.statusRevision);
    if (incomingRevision > 0 && currentRevision > incomingRevision) return thread;
    return {
      ...thread,
      status: change.status,
      statusRevision: incomingRevision > 0 ? incomingRevision : currentRevision,
    };
  });
}

export function mergeThreadList(currentThreads, refreshedThreads) {
  const currentById = new Map(
    (Array.isArray(currentThreads) ? currentThreads : [])
      .filter(thread => thread?.id)
      .map(thread => [thread.id, thread]),
  );
  return (Array.isArray(refreshedThreads) ? refreshedThreads : []).map(thread => {
    const current = currentById.get(thread?.id);
    if (!current || revision(current.statusRevision) <= revision(thread.statusRevision)) {
      return thread;
    }
    return {
      ...thread,
      status: current.status,
      statusRevision: current.statusRevision,
    };
  });
}

export function threadStatusPresentation(status) {
  if (status?.type === 'active') {
    const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    const waiting = flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput');
    return waiting
      ? { kind: 'needs-you', label: 'needs you', active: true }
      : { kind: 'running', label: 'running', active: true };
  }
  if (status?.type === 'systemError') {
    return { kind: 'error', label: 'error', active: false };
  }
  if (status?.type === 'notLoaded') {
    return { kind: 'not-loaded', label: 'not loaded', active: false };
  }
  return { kind: 'idle', label: 'idle', active: false };
}
