/**
 * Every error the API returns is an ApiError, so responses share one shape:
 *
 *   { "error": { "code": "NOT_FOUND", "message": "...", "details"?: ... },
 *     "requestId": "..." }
 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  // Authentication / authorization codes (Phase 2). Semantic codes the client
  // keys off; each still maps onto one HTTP status below.
  | 'AUTH_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_DISABLED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'BRANCH_ACCESS_DENIED'
  // Booking dispatch workflow codes (Phase 4B).
  | 'BOOKING_NOT_READY'
  | 'BOOKING_ALREADY_SENT'
  | 'BOOKING_ALREADY_COMPLETED'
  | 'WARNINGS_NOT_ACKNOWLEDGED'
  | 'DUPLICATE_BOOKING'
  // Proof-of-creation workflow codes (Milestone 5).
  | 'PROOF_REQUIRED'
  | 'UNSUPPORTED_MEDIA'
  | 'FILE_TOO_LARGE'
  | 'PROOF_NOT_PENDING'
  | 'PROOF_ALREADY_REVIEWED'
  | 'REVIEW_REASON_REQUIRED'
  // Reception shift codes. The client keys off SHIFT_CHECK_IN_REQUIRED to open
  // the shift picker, so it must be distinguishable from any other 422.
  | 'SHIFT_CHECK_IN_REQUIRED';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_DISABLED: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  BRANCH_ACCESS_DENIED: 403,
  BOOKING_NOT_READY: 422,
  BOOKING_ALREADY_SENT: 409,
  BOOKING_ALREADY_COMPLETED: 409,
  WARNINGS_NOT_ACKNOWLEDGED: 422,
  DUPLICATE_BOOKING: 409,
  PROOF_REQUIRED: 422,
  UNSUPPORTED_MEDIA: 415,
  FILE_TOO_LARGE: 413,
  PROOF_NOT_PENDING: 409,
  PROOF_ALREADY_REVIEWED: 409,
  REVIEW_REASON_REQUIRED: 422,
  SHIFT_CHECK_IN_REQUIRED: 422,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError('BAD_REQUEST', message, details);
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError('VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Bạn cần đăng nhập.'): ApiError {
    return new ApiError('UNAUTHORIZED', message);
  }

  static forbidden(message = 'Bạn không có quyền thực hiện thao tác này.'): ApiError {
    return new ApiError('FORBIDDEN', message);
  }

  static notFound(message = 'Không tìm thấy tài nguyên.'): ApiError {
    return new ApiError('NOT_FOUND', message);
  }

  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError('CONFLICT', message, details);
  }

  static internal(message = 'Đã xảy ra lỗi hệ thống.'): ApiError {
    return new ApiError('INTERNAL_ERROR', message);
  }

  static authRequired(message = 'Bạn cần đăng nhập.'): ApiError {
    return new ApiError('AUTH_REQUIRED', message);
  }

  /** Deliberately generic: never reveals whether username or password was wrong. */
  static invalidCredentials(message = 'Tên đăng nhập hoặc mật khẩu không đúng.'): ApiError {
    return new ApiError('INVALID_CREDENTIALS', message);
  }

  static accountDisabled(message = 'Tài khoản đã bị vô hiệu hoá.'): ApiError {
    return new ApiError('ACCOUNT_DISABLED', message);
  }

  static passwordChangeRequired(
    message = 'Bạn phải đổi mật khẩu trước khi tiếp tục.',
  ): ApiError {
    return new ApiError('PASSWORD_CHANGE_REQUIRED', message);
  }

  static branchAccessDenied(message = 'Bạn không có quyền truy cập chi nhánh này.'): ApiError {
    return new ApiError('BRANCH_ACCESS_DENIED', message);
  }

  static bookingNotReady(message: string, details?: unknown): ApiError {
    return new ApiError('BOOKING_NOT_READY', message, details);
  }

  static bookingAlreadySent(message = 'Đơn đã được gửi trước đó.', details?: unknown): ApiError {
    return new ApiError('BOOKING_ALREADY_SENT', message, details);
  }

  static bookingAlreadyCompleted(message = 'Đơn đã được hoàn thành trước đó.', details?: unknown): ApiError {
    return new ApiError('BOOKING_ALREADY_COMPLETED', message, details);
  }

  static warningsNotAcknowledged(message: string, details?: unknown): ApiError {
    return new ApiError('WARNINGS_NOT_ACKNOWLEDGED', message, details);
  }

  static duplicateBooking(message: string, details?: unknown): ApiError {
    return new ApiError('DUPLICATE_BOOKING', message, details);
  }

  static proofRequired(message = 'Cần tải lên ít nhất một ảnh chụp màn hình.'): ApiError {
    return new ApiError('PROOF_REQUIRED', message);
  }

  static unsupportedMedia(message = 'Chỉ chấp nhận ảnh PNG, JPEG hoặc WebP.'): ApiError {
    return new ApiError('UNSUPPORTED_MEDIA', message);
  }

  static fileTooLarge(message = 'Ảnh vượt quá dung lượng tối đa 10 MB.'): ApiError {
    return new ApiError('FILE_TOO_LARGE', message);
  }

  static proofNotPending(message = 'Ảnh này không ở trạng thái chờ duyệt.', details?: unknown): ApiError {
    return new ApiError('PROOF_NOT_PENDING', message, details);
  }

  static proofAlreadyReviewed(message = 'Ảnh này đã được duyệt trước đó.', details?: unknown): ApiError {
    return new ApiError('PROOF_ALREADY_REVIEWED', message, details);
  }

  static reviewReasonRequired(message = 'Cần chọn lý do khi từ chối.'): ApiError {
    return new ApiError('REVIEW_REASON_REQUIRED', message);
  }

  /** The receptionist has no open shift, so the server cannot say who they are. */
  static shiftCheckInRequired(
    message = 'Vui lòng chọn ca làm việc trước khi tạo đơn.',
    details?: unknown,
  ): ApiError {
    return new ApiError('SHIFT_CHECK_IN_REQUIRED', message, details);
  }
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
  requestId: string;
}
