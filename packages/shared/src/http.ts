/**
 * Standard HTTP response contracts shared between the API and admin app.
 * The NestJS global exception filter (apps/api) produces errors in this
 * shape; the admin app's API client (apps/admin) consumes it.
 */

export interface ApiErrorResponse {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
  requestId?: string;
}

export interface ApiSuccessResponse<T> {
  data: T;
  timestamp: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
