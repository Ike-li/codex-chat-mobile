export function isDefinitelyUnattempted(request) {
  const attempts = request?.attempts;
  return request?.state === 'pending'
    && (attempts === undefined || attempts === null || attempts === 0)
    && !request?.attemptedGatewayEpoch;
}

export function isProvisionalInstanceOrphan(request, context = {}) {
  const instanceId = request?.payload?.instanceId;
  if (!instanceId || request?.payload?.threadId) return false;
  if (instanceId === context.currentInstanceId) return false;
  if (context.instanceSnapshotReceived !== true) return false;
  const activeInstanceIds = context.activeInstanceIds instanceof Set
    ? context.activeInstanceIds
    : new Set(Array.isArray(context.activeInstanceIds) ? context.activeInstanceIds : []);
  return !activeInstanceIds.has(instanceId);
}
