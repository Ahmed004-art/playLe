import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import type { ApiErrorResponse } from '@playle/shared';

/**
 * Centralized exception handling. Every error the API returns — expected
 * (HttpException) or unexpected (anything else) — is normalized to the
 * ApiErrorResponse shape from @playle/shared so clients never have to
 * branch on error format.
 *
 * Never include stack traces or internal error details in the response
 * body; they go to the server log only (see docs/architecture/SECURITY.md).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const statusCode = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const responseBody = isHttpException ? exception.getResponse() : null;

    const message = this.extractMessage(
      responseBody,
      exception,
      isHttpException,
    );
    const error = isHttpException
      ? exception.name.replace(/Exception$/, '')
      : 'Internal Server Error';

    if (!isHttpException) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ApiErrorResponse = {
      statusCode,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    response.status(statusCode).json(body);
  }

  private extractMessage(
    responseBody: unknown,
    exception: unknown,
    isHttpException: boolean,
  ): string | string[] {
    if (
      isHttpException &&
      typeof responseBody === 'object' &&
      responseBody !== null &&
      'message' in responseBody
    ) {
      return (responseBody as { message: string | string[] }).message;
    }
    if (isHttpException && typeof responseBody === 'string') {
      return responseBody;
    }
    if (exception instanceof Error) {
      return 'Internal server error';
    }
    return 'Internal server error';
  }
}
