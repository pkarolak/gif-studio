export interface Outcome<T> {
  data: T;
  summary: string;
  next: string[];
}

export class StudioError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'StudioError';
  }
}

export function outcome<T>(data: T, summary: string, next: string[] = []): Outcome<T> {
  return {data, summary, next};
}
