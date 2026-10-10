import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError, type ApiErrorBody } from '../lib/errors';
import { isProduction, isTest } from '../config/env';

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  if (err instanceof ZodError) {
    return ApiError.validation('Dữ liệu không hợp lệ.', {
      issues: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return ApiError.conflict('Dữ liệu đã tồn tại.', { fields: err.meta?.target });
    }
    if (err.code === 'P2025') {
      return ApiError.notFound('Không tìm thấy bản ghi.');
    }
    // A table or column the code needs does not exist: the database is behind
    // the code — a migration was not applied. Still a server error, but one
    // that says what to do instead of an anonymous "lỗi hệ thống".
    if (err.code === 'P2021' || err.code === 'P2022') {
      return ApiError.internal('Cơ sở dữ liệu chưa được cập nhật. Chạy: npm run db:migrate rồi khởi động lại máy chủ.');
    }
  }

  // Malformed JSON bodies surface as a SyntaxError from express.json().
  if (err instanceof SyntaxError && 'body' in err) {
    return ApiError.badRequest('Nội dung JSON không hợp lệ.');
  }

  return ApiError.internal();
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const apiError = toApiError(err);

  // Unexpected failures are logged with their stack; expected ones are not noise.
  if (apiError.status >= 500 && !isTest) {
    // eslint-disable-next-line no-console
    console.error(`[${req.requestId}] ${req.method} ${req.originalUrl}`, err);
  }

  const body: ApiErrorBody = {
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details === undefined ? {} : { details: apiError.details }),
    },
    requestId: req.requestId,
  };

  // Never leak internals in production; in development the stack aids debugging.
  if (!isProduction && apiError.status >= 500 && err instanceof Error) {
    body.error.details = { stack: err.stack };
  }

  res.status(apiError.status).json(body);
}
