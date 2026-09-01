/** Error carrying an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (code: string, message: string) =>
  new HttpError(400, code, message);
export const unauthorized = (message = 'Not authenticated') =>
  new HttpError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Not allowed') =>
  new HttpError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') =>
  new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code: string, message: string) =>
  new HttpError(409, code, message);
export const tooMany = (message = 'Slow down') =>
  new HttpError(429, 'RATE_LIMITED', message);
