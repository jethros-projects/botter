/** An invalid invocation, distinct from an authentication or service failure. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'usage_error';
  }
}
