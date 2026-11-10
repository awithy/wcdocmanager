export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = statusCode === 404 ? 'Not Found' : statusCode === 409 ? 'Conflict' : 'Bad Request';
  }
}

export const notFound = (msg: string) => new HttpError(404, msg);
export const badRequest = (msg: string) => new HttpError(400, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
