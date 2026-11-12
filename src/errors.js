export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const cancelled = () => new AppError(499, 'CANCELLED', 'Response interrupted.');
export function publicError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error?.name === 'AbortError') return { code: 'CANCELLED', message: 'Response interrupted.' };
  return { code: 'SERVICE_ERROR', message: 'The assistant could not finish. Please retry.' };
}
export function checkAbort(signal) { if (signal?.aborted) throw cancelled(); }
