import 'package:flutter/foundation.dart';

import '../logging/app_logger.dart';
import 'social_errors.dart';
import 'social_models.dart';

sealed class PagedListState<T> {
  const PagedListState();
}

class PagedListLoading<T> extends PagedListState<T> {
  const PagedListLoading();
}

class PagedListLoaded<T> extends PagedListState<T> {
  const PagedListLoaded({
    required this.items,
    required this.hasMore,
    this.isLoadingMore = false,
    this.loadMoreError,
  });

  final List<T> items;
  final bool hasMore;
  final bool isLoadingMore;

  /// Set when fetching a further page failed; the pages already shown stay.
  final String? loadMoreError;
}

class PagedListError<T> extends PagedListState<T> {
  const PagedListError(this.message);
  final String message;
}

/// The session is no longer valid; the user must sign in again.
class PagedListUnauthorized<T> extends PagedListState<T> {
  const PagedListUnauthorized();
}

/// Fetches one page: [cursor] is `null` for the first page.
typedef PageFetcher<T> =
    Future<SocialPage<T>> Function(String? cursor, int limit);

/// One cursor-paged list from the social API (friends, incoming requests, sent
/// requests, blocked players), with the loading / error / retry / "load more"
/// behaviour every one of them needs.
///
/// - **Never double-fetches:** [load] and [loadMore] do nothing while a request
///   of the same kind is in flight.
/// - **Reconciles with the server:** [reload] re-fetches the first page quietly
///   (no spinner) and replaces what is shown. A reload asked for *while one is
///   already running* is remembered and run once more afterwards, so a change
///   that happened mid-request is never missed. A failed quiet reload keeps
///   what is already on screen.
/// - **Safe on dispose:** a reply arriving after [dispose] is dropped.
/// - [removeWhere] drops items the server has just confirmed are gone; it is
///   never used to invent a change the server has not confirmed.
class PagedListController<T> extends ChangeNotifier {
  PagedListController({
    required this._fetchPage,
    required this._idOf,
    this.pageSize = 20,
  });

  final PageFetcher<T> _fetchPage;
  final String Function(T item) _idOf;
  final int pageSize;

  PagedListState<T> _state = PagedListLoading<T>();
  PagedListState<T> get state => _state;

  final List<T> _items = [];
  String? _nextCursor;

  bool _loadingFirstPage = false;
  bool _loadingMore = false;
  bool _reloadQueued = false;
  bool _disposed = false;

  /// Loads (or reloads, with a spinner) the first page.
  Future<void> load() async {
    if (_loadingFirstPage) {
      return;
    }
    _setState(PagedListLoading<T>());
    await _fetchFirstPage(quiet: false);
  }

  /// Re-fetches the first page without a spinner.
  Future<void> reload() async {
    if (_loadingFirstPage) {
      _reloadQueued = true;
      return;
    }
    await _fetchFirstPage(quiet: true);
  }

  Future<void> _fetchFirstPage({required bool quiet}) async {
    _loadingFirstPage = true;
    try {
      final page = await _fetchPage(null, pageSize);
      _items
        ..clear()
        ..addAll(page.items);
      _nextCursor = page.nextCursor;
      _setState(_loaded());
    } catch (e) {
      AppLogger.instance.warning('Failed to load a social list: $e');
      if (classifyFailure(e) == SocialFailureKind.unauthorized) {
        _setState(PagedListUnauthorized<T>());
      } else if (quiet && _state is PagedListLoaded<T>) {
        // Keep what is on screen; the next reload will try again.
      } else {
        _setState(PagedListError<T>(friendlyFailureMessage(e)));
      }
    } finally {
      _loadingFirstPage = false;
    }
    if (_reloadQueued && !_disposed) {
      _reloadQueued = false;
      await _fetchFirstPage(quiet: true);
    }
  }

  /// Loads the next page, if there is one. Does nothing while a page is
  /// already loading, before the first page has loaded, or on the last page.
  Future<void> loadMore() async {
    final cursor = _nextCursor;
    if (_loadingMore ||
        _loadingFirstPage ||
        cursor == null ||
        _state is! PagedListLoaded<T>) {
      return;
    }
    _loadingMore = true;
    _setState(_loaded(isLoadingMore: true));
    try {
      final page = await _fetchPage(cursor, pageSize);
      final known = _items.map(_idOf).toSet();
      _items.addAll(page.items.where((i) => !known.contains(_idOf(i))));
      _nextCursor = page.nextCursor;
      _setState(_loaded());
    } catch (e) {
      AppLogger.instance.warning('Failed to load more of a social list: $e');
      if (classifyFailure(e) == SocialFailureKind.unauthorized) {
        _setState(PagedListUnauthorized<T>());
      } else {
        _setState(_loaded(loadMoreError: friendlyFailureMessage(e)));
      }
    } finally {
      _loadingMore = false;
    }
  }

  /// Drops items the server has confirmed are gone (e.g. a request it just
  /// accepted). Does nothing unless the list is loaded.
  void removeWhere(bool Function(T item) test) {
    if (_state is! PagedListLoaded<T>) {
      return;
    }
    _items.removeWhere(test);
    final current = _state as PagedListLoaded<T>;
    _setState(
      _loaded(
        isLoadingMore: current.isLoadingMore,
        loadMoreError: current.loadMoreError,
      ),
    );
  }

  PagedListLoaded<T> _loaded({
    bool isLoadingMore = false,
    String? loadMoreError,
  }) {
    return PagedListLoaded<T>(
      items: List<T>.unmodifiable(_items),
      hasMore: _nextCursor != null,
      isLoadingMore: isLoadingMore,
      loadMoreError: loadMoreError,
    );
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

  void _setState(PagedListState<T> next) {
    if (_disposed) {
      return;
    }
    _state = next;
    notifyListeners();
  }
}
