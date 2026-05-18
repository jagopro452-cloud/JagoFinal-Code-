import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';
import '../main.dart' show navigatorKey;
import '../screens/splash_screen.dart';
import 'device_identity_service.dart';
import 'fcm_service.dart';

enum SessionValidationState { valid, unauthorized, retryableFailure }

class SessionValidationResult {
  const SessionValidationResult(this.state, {this.profile});

  final SessionValidationState state;
  final Map<String, dynamic>? profile;

  bool get isValid => state == SessionValidationState.valid;
  bool get isRetryable => state == SessionValidationState.retryableFailure;
}

class AuthService {
  static const _tokenKey = 'auth_token';
  static const _refreshTokenKey = 'refresh_token';
  static const _userKey = 'user_data';
  static const _userNameKey = 'user_name';
  static const _userPhoneKey = 'user_phone';
  static const _userIdKey = 'user_id';
  static const _activeTripKey = 'active_customer_trip_id';

  static Completer<void>? _logoutInFlight;
  static int _handle401RetryCount = 0;
  static const _handle401MaxRetries = 2;

  static const Map<String, String> _base = {
    'Content-Type': 'application/json',
    'User-Agent': 'JAGOPro-Customer/1.0 (Android)',
    'Accept': 'application/json',
  };

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_tokenKey)?.trim();
    if (token == null || token.isEmpty) return null;
    return token;
  }

  static Future<String?> getRefreshToken() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_refreshTokenKey)?.trim();
    if (token == null || token.isEmpty) return null;
    return token;
  }

  static Future<bool> isLoggedIn() async {
    final token = await getToken();
    return token != null && token.isNotEmpty;
  }

  static Future<void> saveToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token.trim());
  }

  static Future<void> saveRefreshToken(String? refreshToken) async {
    final prefs = await SharedPreferences.getInstance();
    final value = refreshToken?.trim() ?? '';
    if (value.isEmpty) {
      await prefs.remove(_refreshTokenKey);
      return;
    }
    await prefs.setString(_refreshTokenKey, value);
  }

  static Future<void> saveUser(Map<String, dynamic> userData) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_userKey, jsonEncode(userData));

    final name = userData['fullName'] ??
        userData['full_name'] ??
        userData['name'] ??
        '';
    final phone = userData['phone'] ?? '';
    final id = userData['id']?.toString() ??
        userData['userId']?.toString() ??
        userData['user_id']?.toString() ??
        '';

    if (name.toString().isNotEmpty) {
      await prefs.setString(_userNameKey, name.toString());
    } else {
      await prefs.remove(_userNameKey);
    }

    if (phone.toString().isNotEmpty) {
      await prefs.setString(_userPhoneKey, phone.toString());
    } else {
      await prefs.remove(_userPhoneKey);
    }

    if (id.isNotEmpty) {
      await prefs.setString(_userIdKey, id);
    } else {
      await prefs.remove(_userIdKey);
    }
  }

  static Future<Map<String, dynamic>?> getSavedUser() async {
    final prefs = await SharedPreferences.getInstance();
    final data = prefs.getString(_userKey);
    if (data == null || data.isEmpty) return null;
    try {
      final decoded = jsonDecode(data);
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {}
    return null;
  }

  static Future<void> clearLocalSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_refreshTokenKey);
    await prefs.remove(_userKey);
    await prefs.remove(_userNameKey);
    await prefs.remove(_userPhoneKey);
    await prefs.remove(_userIdKey);
  }

  static Future<Map<String, String>> getHeaders() async {
    final token = await getToken();
    return {..._base, if (token != null) 'Authorization': 'Bearer $token'};
  }

  static Future<void> _persistAuthPayload(
    Map<String, dynamic> data, {
    required String fallbackPhone,
    String fallbackName = '',
  }) async {
    final token = data['token']?.toString().trim() ?? '';
    if (token.isEmpty) return;

    await saveToken(token);
    await saveRefreshToken(data['refreshToken']?.toString());

    final rawUser = data['user'];
    final user = rawUser is Map
        ? Map<String, dynamic>.from(rawUser)
        : Map<String, dynamic>.from(data);

    if ((user['phone']?.toString() ?? '').isEmpty && fallbackPhone.isNotEmpty) {
      user['phone'] = fallbackPhone;
    }
    if ((user['fullName']?.toString() ?? '').isEmpty && fallbackName.isNotEmpty) {
      user['fullName'] = fallbackName;
    }

    await saveUser(user);
    FcmService().onLoginSuccess().catchError((_) {});
  }

  static Future<SessionValidationResult> validateStoredSession() async {
    final token = await getToken();
    if (token == null || token.isEmpty) {
      return const SessionValidationResult(SessionValidationState.unauthorized);
    }

    try {
      final res = await http.get(
        Uri.parse(ApiConfig.customerProfile),
        headers: {..._base, 'Authorization': 'Bearer $token'},
      ).timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        if ((res.headers['content-type'] ?? '').contains('application/json')) {
          final decoded = jsonDecode(res.body);
          if (decoded is Map) {
            final profile = Map<String, dynamic>.from(decoded);
            await saveUser(profile);
            return SessionValidationResult(
              SessionValidationState.valid,
              profile: profile,
            );
          }
        }
        return const SessionValidationResult(SessionValidationState.valid);
      }

      if (res.statusCode == 401) {
        return const SessionValidationResult(SessionValidationState.unauthorized);
      }

      return SessionValidationResult(
        SessionValidationState.retryableFailure,
        profile: await getSavedUser(),
      );
    } on TimeoutException {
      return SessionValidationResult(
        SessionValidationState.retryableFailure,
        profile: await getSavedUser(),
      );
    } catch (_) {
      return SessionValidationResult(
        SessionValidationState.retryableFailure,
        profile: await getSavedUser(),
      );
    }
  }

  static Future<bool> rehydrateStoredSession({bool refreshProfile = true}) async {
    final token = await getToken();
    if (token == null || token.isEmpty) return false;

    final savedUser = await getSavedUser();
    if (savedUser != null && savedUser.isNotEmpty) {
      await saveUser(savedUser);
    }

    if (!refreshProfile) return true;

    final validation = await validateStoredSession();
    if (validation.state == SessionValidationState.unauthorized) {
      await clearLocalSession();
      return false;
    }

    return true;
  }

  static Future<bool> tryRefreshSession() async {
    final refreshToken = await getRefreshToken();
    if (refreshToken == null || refreshToken.isEmpty) return false;
    try {
      final res = await http
          .post(
            Uri.parse(ApiConfig.refreshSession),
            headers: {
              ..._base,
              'Authorization': 'Bearer $refreshToken',
            },
            body: jsonEncode({
              'deviceId': await DeviceIdentityService.getDeviceId(),
            }),
          )
          .timeout(const Duration(seconds: 15));
      if (res.statusCode != 200) return false;
      final decoded = jsonDecode(res.body);
      if (decoded is! Map) return false;
      final data = Map<String, dynamic>.from(decoded);
      final newAccessToken = data['accessToken']?.toString().trim() ?? '';
      final newRefreshToken = data['refreshToken']?.toString().trim() ?? '';
      if (newAccessToken.isEmpty || newRefreshToken.isEmpty) return false;
      await saveToken(newAccessToken);
      await saveRefreshToken(newRefreshToken);
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<void> logout() async {
    try {
      final headers = await getHeaders();
      await http
          .post(Uri.parse(ApiConfig.logout), headers: headers)
          .timeout(const Duration(seconds: 30));
    } catch (_) {}
    await clearLocalSession();
  }

  static Future<void> handle401({String source = 'unknown'}) async {
    if (_logoutInFlight != null) {
      return _logoutInFlight!.future;
    }

    // Guard against infinite retry loops (max 2 refresh attempts before forcing logout)
    if (_handle401RetryCount >= _handle401MaxRetries) {
      _handle401RetryCount = 0;
      await clearLocalSession();
      navigatorKey.currentState?.pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const SplashScreen()),
        (route) => false,
      );
      return;
    }

    final completer = Completer<void>();
    _logoutInFlight = completer;

    try {
      if (await hasActiveTripSession()) {
        _handle401RetryCount++;
        await tryRefreshSession();
        return;
      }
      _handle401RetryCount++;
      final recovered = await tryRefreshSession();
      if (recovered) {
        _handle401RetryCount = 0;
        return;
      }

      // Socket auth errors can arrive during reconnect/deploy races. Confirm
      // the HTTP session is truly invalid before removing a fresh login.
      final validation = await validateStoredSession();
      if (validation.isValid || validation.isRetryable) {
        _handle401RetryCount = 0;
        return;
      }

      _handle401RetryCount = 0;
      debugPrint('[AUTH] Confirmed unauthorized from $source, clearing session');
      await clearLocalSession();
      navigatorKey.currentState?.pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const SplashScreen()),
        (route) => false,
      );
    } finally {
      completer.complete();
      _logoutInFlight = null;
    }
  }

  static Future<bool> hasActiveTripSession() async {
    final prefs = await SharedPreferences.getInstance();
    final tripId = prefs.getString(_activeTripKey)?.trim() ?? '';
    return tripId.isNotEmpty;
  }

  static Future<Map<String, dynamic>?> getProfile({
    bool allowCachedFallback = true,
  }) async {
    try {
      final headers = await getHeaders();
      final res = await http
          .get(Uri.parse(ApiConfig.customerProfile), headers: headers)
          .timeout(const Duration(seconds: 30));
      if (res.statusCode == 200) {
        final decoded = jsonDecode(res.body);
        if (decoded is Map) {
          final profile = Map<String, dynamic>.from(decoded);
          await saveUser(profile);
          return profile;
        }
      } else if (res.statusCode == 401) {
        return null;
      }
    } on TimeoutException {
      if (allowCachedFallback) return getSavedUser();
      return null;
    } catch (_) {
      if (allowCachedFallback) return getSavedUser();
      return null;
    }

    return allowCachedFallback ? getSavedUser() : null;
  }

  static Future<Map<String, dynamic>> updateProfile({
    String? fullName,
    String? email,
  }) async {
    try {
      final headers = await getHeaders();
      final body = <String, dynamic>{};
      if (fullName != null) body['fullName'] = fullName;
      if (email != null) body['email'] = email;
      final res = await http
          .patch(
            Uri.parse(ApiConfig.updateProfile),
            headers: headers,
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 30));
      return jsonDecode(res.body);
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Request timed out. Check your connection.',
      };
    } catch (_) {
      return {
        'success': false,
        'message': 'Network error. Check your connection.',
      };
    }
  }

  static Future<Map<String, dynamic>> loginWithPassword(
    String phone,
    String password,
  ) async {
    try {
      final res = await http
          .post(
            Uri.parse(ApiConfig.loginPassword),
            headers: _base,
            body: jsonEncode({
              'phone': phone,
              'password': password,
              'userType': 'customer',
              'deviceId': await DeviceIdentityService.getDeviceId(),
            }),
          )
          .timeout(const Duration(seconds: 30));
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await _persistAuthPayload(data, fallbackPhone: phone);
      }
      return data;
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Request timed out. Check your connection.',
      };
    } catch (_) {
      return {
        'success': false,
        'message': 'Network error. Check your connection.',
      };
    }
  }

  static Future<Map<String, dynamic>> registerWithPassword(
    String phone,
    String password,
    String fullName, {
    String? email,
  }) async {
    try {
      final res = await http
          .post(
            Uri.parse(ApiConfig.registerAccount),
            headers: _base,
            body: jsonEncode({
              'phone': phone,
              'password': password,
              'fullName': fullName,
              'email': email,
              'userType': 'customer',
              'deviceId': await DeviceIdentityService.getDeviceId(),
            }),
          )
          .timeout(const Duration(seconds: 30));
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await _persistAuthPayload(data, fallbackPhone: phone);
      }
      return data;
    } on TimeoutException {
      return {
        'success': false,
        'message': 'Request timed out. Check your connection.',
      };
    } catch (_) {
      return {
        'success': false,
        'message': 'Network error. Check your connection.',
      };
    }
  }

}
