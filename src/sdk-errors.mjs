const messages = {
  INVALID_ARGUMENT: 'The request is invalid.', AUTH_REQUIRED: 'Sign in with botter login first.',
  AUTH_FAILED: 'Authentication failed. Check your session and try again.',
  UNSUPPORTED_OPERATION: 'This operation is outside the verified service support.',
  NETWORK_ERROR: 'The service could not be reached.', TIMEOUT: 'The operation timed out.',
  ABORTED: 'The operation was cancelled.', CLOSED: 'This Botter client is closed.',
  RESYNC_REQUIRED: 'Reload history before starting a new watch.', OPERATION_FAILED: 'The operation failed.',
};

export class BotterError extends Error {
  constructor(message, { code = 'OPERATION_FAILED', status, requestId, receipt, deliveryState, nativeCode } = {}) {
    super(message ?? messages[code] ?? messages.OPERATION_FAILED);
    this.name = 'BotterError'; this.code = code;
    for (const [key, value] of Object.entries({ status, requestId, receipt, deliveryState, nativeCode })) {
      if (value !== undefined) this[key] = value;
    }
  }
}

export const invalid = message => new BotterError(message, { code: 'INVALID_ARGUMENT' });
export function sdkError(error, signal) {
  if (error instanceof BotterError) return error;
  const nativeCode = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code) ? error.code : undefined;
  let code = 'OPERATION_FAILED';
  if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    code = (signal?.reason ?? error)?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED';
    if (signal?.reason instanceof BotterError) return signal.reason;
  } else if (error?.status === 401 || ['auth_required', 'unauthenticated'].includes(nativeCode)) code = 'AUTH_REQUIRED';
  else if (error?.status === 403 || nativeCode?.startsWith('auth_')) code = 'AUTH_FAILED';
  else if (error?.name === 'UnsupportedOperationError' || /NOT_ALLOWED|UNSUPPORTED|BOX_UPLOAD_REQUIRED/.test(nativeCode ?? '')) code = 'UNSUPPORTED_OPERATION';
  else if (error?.name === 'ApiSchemaError' || /^(?:INVALID_|FILE_TOO_LARGE)/.test(nativeCode ?? '')) code = 'INVALID_ARGUMENT';
  else if (error instanceof TypeError || /NETWORK|ECONN|ENOTFOUND|EAI_AGAIN/.test(nativeCode ?? '')) code = 'NETWORK_ERROR';
  return new BotterError(messages[code], { code, nativeCode,
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.requestId === 'string' && /^[\w-]{1,128}$/.test(error.requestId) ? { requestId: error.requestId } : {}) });
}
