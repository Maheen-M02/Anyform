/** An error with a stable code that the server maps onto its own AppError. */
export class SandboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}

export type Progress = (fraction: number) => void
