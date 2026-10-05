import 'package:dio/dio.dart';

import '../config/app_config.dart';
import '../errors/app_exception.dart';
import '../logging/app_logger.dart';

/// Thin abstraction over the HTTP client used to talk to the PlayLe API.
///
/// Call sites depend on [ApiClient], not on `package:dio` directly, so the
/// underlying HTTP implementation can change without touching feature code.
///
/// [getAccessToken] is called before every request to attach
/// `Authorization: Bearer <token>` when a session exists. It's a callback
/// rather than a direct [SecureStorage] dependency so this client doesn't
/// need to know anything about how/where tokens are persisted — see
/// `core/di/service_locator.dart` for the wiring.
class ApiClient {
  ApiClient({required AppConfig config, this.getAccessToken, Dio? dio})
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
        onRequest: (options, handler) async {
          final token = await getAccessToken?.call();
          if (token != null) {
            options.headers['Authorization'] = 'Bearer $token';
          }
          // Never log request/response bodies here — they can contain
          // passwords, tokens, or other sensitive auth material.
          AppLogger.instance.debug('-> ${options.method} ${options.path}');
          handler.next(options);
        },
        onError: (error, handler) {
          AppLogger.instance.warning(
            'API error: ${error.requestOptions.method} ${error.requestOptions.path} '
            '(${error.response?.statusCode})',
          );
          handler.next(error);
        },
      ),
    );
  }

  final Dio _dio;
  final Future<String?> Function()? getAccessToken;

  Future<Response<T>> get<T>(
    String path, {
    Map<String, dynamic>? queryParameters,
  }) async {
    try {
      return await _dio.get<T>(path, queryParameters: queryParameters);
    } on DioException catch (e) {
      throw _toNetworkException(e);
    }
  }

  Future<Response<T>> post<T>(
    String path, {
    Object? data,
    Map<String, dynamic>? headers,
  }) async {
    try {
      return await _dio.post<T>(
        path,
        data: data,
        options: headers != null ? Options(headers: headers) : null,
      );
    } on DioException catch (e) {
      throw _toNetworkException(e);
    }
  }

  NetworkException _toNetworkException(DioException e) {
    final body = e.response?.data;
    String message = e.message ?? 'Network request failed';

    // The API's standard error shape (see packages/shared/src/http.ts):
    // { statusCode, error, message, path, timestamp }. `message` may be a
    // single string or an array of validation-failure strings.
    if (body is Map && body['message'] != null) {
      final raw = body['message'];
      message = raw is List ? raw.join(', ') : raw.toString();
    }

    return NetworkException(message, statusCode: e.response?.statusCode);
  }
}
