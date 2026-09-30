import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ServiceError } from './service.error';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      error instanceof ServiceError
        ? error.status
        : error instanceof ZodError
          ? 400
          : error instanceof HttpException
            ? error.getStatus()
            : 500;
    response.status(status).json({
      error: {
        code:
          error instanceof ServiceError
            ? error.code
            : status === 400
              ? 'INVALID_ARGUMENT'
              : 'REQUEST_FAILED',
        message:
          error instanceof ServiceError
            ? error.message
            : status === 500
              ? 'Service unavailable'
              : 'Request rejected',
        retryable: error instanceof ServiceError && error.retryable,
      },
    });
  }
}
