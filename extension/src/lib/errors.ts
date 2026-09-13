/** User-facing failures. Messages never contain credentials or signed URLs. */
export class BiliVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ApiError extends BiliVaultError {
  constructor(
    public readonly endpoint: string,
    public readonly code: string | number,
    message?: string,
  ) {
    super(message ?? `${endpoint}: API 错误 ${code}`);
  }
}

export class LoginRequired extends BiliVaultError {}
export class NoSubtitles extends BiliVaultError {}
export class IdentityMismatch extends BiliVaultError {}
export class TrackUnavailable extends BiliVaultError {}
export class HttpFailure extends BiliVaultError {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
  ) {
    super(`${endpoint}: HTTP ${status}`);
  }
}
export class UnstableSubtitle extends BiliVaultError {}
export class NotConfigured extends BiliVaultError {}
