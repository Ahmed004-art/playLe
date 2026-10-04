import 'package:dio/dio.dart';

import '../config/app_config.dart';
import '../errors/app_exception.dart';
import '../logging/app_logger.dart';

/// Thin abstraction over the HTTP client used to talk to the PlayLe API.
///
/// Call sites depend on [ApiClient], not on `package:dio` directly, so the
/// underlying HTTP implementation can change without touching feature code.
/// An auth interceptor that attaches the current session token will be
/// added here once authentication is implemented (see
/// docs/architecture/SECURITY.md — "Authentication architecture
/// (placeholder)").
class ApiClient {
  ApiClient({required AppConfig config, Dio? dio})
    : _dio =
          dio ??
          Dio(
            BaseOptions(
              baseUrl: config.apiBaseUrl,
              connectTimeout: const Duration(seconds: 10),
              receiveTimeout: const Duration(seconds: 10),
            ),
          ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          AppLogger.instance.debug('-> ${options.method} ${options.path}');
          handler.next(options);
        },
        onError: (error, handler) {
          AppLogger.instance.warning('API error: ${error.message}');
          handler.next(error);
        },
      ),
    );
  }

  final Dio _dio;

  Future<Response<T>> get<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
  }) async {
    try {
      return await _dio.get<T>(path, queryParameters: queryParameters);
    } on DioException catch (e) {
      throw NetworkException(
        e.message ?? 'Network request failed',
        statusCode: e.response?.statusCode,
      );
    }
  }

  Future<Response<T>> post<T>(String path, {Object? data}) async {
    try {
      return await _dio.post<T>(path, data: data);
    } on DioException catch (e) {
      throw NetworkException(
        e.message ?? 'Network request failed',
        statusCode: e.response?.statusCode,
      );
    }
  }
}
