// Error thrown for any policy load failure. `code` is a stable machine-readable
// reason; `pointer` is an RFC 6901 JSON pointer to where it happened ("" = root).
export class PolicyError extends Error {
  constructor(code, message, { pointer = '' } = {}) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.pointer = pointer;
  }
}
