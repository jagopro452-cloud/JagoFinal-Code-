import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../config/api_config.dart';
import 'socket_service.dart';

class RuntimeConfigService {
  RuntimeConfigService._internal();
  static final RuntimeConfigService _instance = RuntimeConfigService._internal();
  factory RuntimeConfigService() => _instance;

  static const _cacheKey = 'driver_runtime_config_snapshot';

  final _configController = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get onConfigChanged => _configController.stream;

  Map<String, dynamic>? _snapshot;
  StreamSubscription<Map<String, dynamic>>? _socketSub;

  Map<String, dynamic>? get snapshot => _snapshot;
  String? get version => _snapshot?['version']?.toString();

  Future<void> initialize() async {
    await _restoreCache();
    _socketSub ??= SocketService().onConfigUpdated.listen((payload) async {
      final snapshot = payload['snapshot'];
      if (snapshot is Map) {
        _snapshot = Map<String, dynamic>.from(snapshot.cast<String, dynamic>());
        await _persistCache();
        _configController.add(_snapshot!);
      } else {
        await refresh();
      }
    });
  }

  Future<void> refresh() async {
    await initialize();
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString('auth_token') ?? '';
    if (token.isEmpty) return;

    final response = await http.get(
      Uri.parse(ApiConfig.runtimeConfig),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
    );

    if (response.statusCode < 200 || response.statusCode >= 300) return;
    final body = jsonDecode(response.body);
    final data = body is Map<String, dynamic> ? body['data'] : null;
    if (data is Map<String, dynamic>) {
      _snapshot = data;
      await _persistCache();
      _configController.add(_snapshot!);
    }
  }

  bool boolValue(String key, {bool defaultValue = false}) {
    final dynamic value = (_snapshot?['effectiveConfig']?['global'] as Map?)?[key];
    if (value is bool) return value;
    if (value is String) {
      final lower = value.toLowerCase();
      if (['true', '1', 'yes', 'on', 'enabled', 'active'].contains(lower)) return true;
      if (['false', '0', 'no', 'off', 'disabled', 'inactive'].contains(lower)) return false;
    }
    return defaultValue;
  }

  dynamic scopedValue({
    required String key,
    String? cityKey,
    String? serviceKey,
    String? vehicleKey,
    dynamic defaultValue,
  }) {
    final effective = _snapshot?['effectiveConfig'];
    if (effective is! Map) return defaultValue;

    final global = (effective['global'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
    dynamic value = global.containsKey(key) ? global[key] : defaultValue;

    if (cityKey != null && cityKey.trim().isNotEmpty) {
      final city = ((effective['city'] as Map?)?[cityKey.trim().toLowerCase()] as Map?)?.cast<String, dynamic>();
      if (city != null && city.containsKey(key)) value = city[key];
    }
    if (serviceKey != null && serviceKey.trim().isNotEmpty) {
      final service = ((effective['service'] as Map?)?[serviceKey.trim().toLowerCase()] as Map?)?.cast<String, dynamic>();
      if (service != null && service.containsKey(key)) value = service[key];
    }
    if (vehicleKey != null && vehicleKey.trim().isNotEmpty) {
      final vehicle = ((effective['vehicle'] as Map?)?[vehicleKey.trim().toLowerCase()] as Map?)?.cast<String, dynamic>();
      if (vehicle != null && vehicle.containsKey(key)) value = vehicle[key];
    }
    return value;
  }

  Future<void> _restoreCache() async {
    if (_snapshot != null) return;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_cacheKey);
    if (raw == null || raw.isEmpty) return;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic>) {
        _snapshot = decoded;
      }
    } catch (_) {}
  }

  Future<void> _persistCache() async {
    final snapshot = _snapshot;
    if (snapshot == null) return;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_cacheKey, jsonEncode(snapshot));
  }

  Future<void> dispose() async {
    await _socketSub?.cancel();
    _socketSub = null;
  }
}
