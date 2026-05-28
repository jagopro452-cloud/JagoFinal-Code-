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

enum SessionValidationState { valid, retryableFailure, unauthorized }

class SessionValidationResult {
  const SessionValidationResult({
    required this.state,
    this.profile,
  });

  final SessionValidationState state;
  final Map<String, dynamic>? profile;
}

class AuthService {
  static const _tokenKey = 'auth_token';
  static const _refreshTokenKey = 'refresh_token';
  static const _userKey = 'user_data';
  static bool _handling401 = false;

  static const Map<String, String> _base = {
    'Content-Type': 'application/json',
    'User-Agent': 'JAGOPro-Customer/1.0 (Android)',
    'Accept': 'application/json',
  };

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  static Future<bool> isLoggedIn() async {
    final token = await getToken();
    return token != null && token.isNotEmpty;
  }

  static Future<Map<String, String>> getHeaders() async {
    final token = await getToken();
    return {..._base, if (token != null) 'Authorization': 'Bearer $token'};
  }

  static Future<void> logout() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final refreshToken = prefs.getString(_refreshTokenKey)?.trim() ?? '';
      final deviceId = await DeviceIdentityService.getDeviceId();
      final headers = await getHeaders();
      await http
          .post(
            Uri.parse(ApiConfig.logout),
            headers: {...headers, 'X-Device-Id': deviceId},
            body: jsonEncode({
              if (refreshToken.isNotEmpty) 'refreshToken': refreshToken,
            }),
          )
          .timeout(
            const Duration(seconds: 30),
          );
    } catch (_) {}
    await _clearStoredSession();
  }

  static Future<void> handle401({String source = 'customer_app'}) async {
    if (_handling401) return;
    _handling401 = true;
    try {
      await _clearStoredSession();
      navigatorKey.currentState?.pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const SplashScreen()),
        (route) => false,
      );
    } finally {
      _handling401 = false;
    }
  }

  static Future<Map<String, dynamic>?> getProfile() async {
    try {
      final headers = await getHeaders();
      final res = await http
          .get(Uri.parse(ApiConfig.customerProfile), headers: headers)
          .timeout(const Duration(seconds: 30));
      if (res.statusCode == 200) {
        return jsonDecode(res.body) as Map<String, dynamic>;
      }
    } on TimeoutException {
      return null;
    } catch (_) {}
    return null;
  }

  static Future<Map<String, dynamic>> getProfileStatus() async {
    try {
      final headers = await getHeaders();
      final res = await http
          .get(Uri.parse(ApiConfig.customerProfile), headers: headers)
          .timeout(const Duration(seconds: 30));
      if (res.statusCode == 200) {
        return {
          'success': true,
          'authorized': true,
          'profile': jsonDecode(res.body),
        };
      }
      if (res.statusCode == 401) {
        return {
          'success': false,
          'authorized': false,
          'temporaryFailure': false,
        };
      }
      return {
        'success': false,
        'authorized': null,
        'temporaryFailure': true,
      };
    } on TimeoutException {
      return {
        'success': false,
        'authorized': null,
        'temporaryFailure': true,
      };
    } catch (_) {
      return {
        'success': false,
        'authorized': null,
        'temporaryFailure': true,
      };
    }
  }

  static Future<void> _clearStoredSession() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
    await prefs.remove(_refreshTokenKey);
    await prefs.remove(_userKey);
    await prefs.remove('user_id');
    await prefs.remove('user_name');
    await prefs.remove('user_phone');
  }

  static Future<Map<String, dynamic>?> getSavedUser() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_userKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map<String, dynamic> ? decoded : null;
    } catch (_) {
      return null;
    }
  }

  static Future<void> clearLocalSession() => _clearStoredSession();

  static Future<bool> rehydrateStoredSession({
    bool refreshProfile = true,
  }) async {
    final token = await getToken();
    if (token == null || token.isEmpty) return false;
    if (!refreshProfile) return true;
    final result = await validateStoredSession();
    return result.state != SessionValidationState.unauthorized;
  }

  static Future<SessionValidationResult> validateStoredSession() async {
    final token = await getToken();
    if (token == null || token.isEmpty) {
      return const SessionValidationResult(
        state: SessionValidationState.unauthorized,
      );
    }

    final status = await getProfileStatus();
    if (status['authorized'] == true) {
      final profile = status['profile'];
      return SessionValidationResult(
        state: SessionValidationState.valid,
        profile: profile is Map<String, dynamic> ? profile : await getSavedUser(),
      );
    }
    if (status['authorized'] == false) {
      final refreshed = await _refreshSession(clearOnFailure: false);
      if (refreshed) {
        return validateStoredSession();
      }
      return const SessionValidationResult(
        state: SessionValidationState.unauthorized,
      );
    }
    return SessionValidationResult(
      state: SessionValidationState.retryableFailure,
      profile: await getSavedUser(),
    );
  }

  static Future<bool> tryRefreshSession() async {
    return _refreshSession();
  }

  static Future<void> _persistAuth(
    String token,
    String? refreshToken,
    Map<String, dynamic> user,
    String fallbackPhone,
  ) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
    if (refreshToken != null && refreshToken.trim().isNotEmpty) {
      await prefs.setString(_refreshTokenKey, refreshToken.trim());
    }
    await prefs.setString(_userKey, jsonEncode(user));
    final name = user['fullName'] ?? user['full_name'] ?? user['name'] ?? '';
    final phone = user['phone'] ?? fallbackPhone;
    final userId = user['id']?.toString() ??
        user['userId']?.toString() ??
        user['user_id']?.toString() ??
        '';
    if (name.toString().isNotEmpty) {
      await prefs.setString('user_name', name.toString());
    }
    if (phone.toString().isNotEmpty) {
      await prefs.setString('user_phone', phone.toString());
    }
    if (userId.isNotEmpty) {
      await prefs.setString('user_id', userId);
    }
    FcmService().onLoginSuccess().catchError((_) {});
  }

  static Future<bool> _refreshSession({bool clearOnFailure = true}) async {
    final prefs = await SharedPreferences.getInstance();
    final refreshToken = prefs.getString(_refreshTokenKey)?.trim() ?? '';
    if (refreshToken.isEmpty) {
      if (clearOnFailure) {
        await _clearStoredSession();
      }
      return false;
    }

    try {
      final deviceId = await DeviceIdentityService.getDeviceId();
      final res = await http
          .post(
            Uri.parse(ApiConfig.refreshSession),
            headers: {..._base, 'X-Device-Id': deviceId},
            body: jsonEncode({
              'refreshToken': refreshToken,
              'deviceId': deviceId,
            }),
          )
          .timeout(const Duration(seconds: 20));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        if (clearOnFailure) {
          await _clearStoredSession();
        }
        return false;
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        final currentUser = await getSavedUser() ?? <String, dynamic>{};
        await _persistAuth(
          data['token'].toString(),
          data['refreshToken']?.toString(),
          currentUser,
          currentUser['phone']?.toString() ?? '',
        );
        return true;
      }
    } on TimeoutException {
      return false;
    } catch (_) {}

    if (clearOnFailure) {
      await _clearStoredSession();
    }
    return false;
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
      return jsonDecode(res.body) as Map<String, dynamic>;
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
      final deviceId = await DeviceIdentityService.getDeviceId();
      final res = await http
          .post(
            Uri.parse(ApiConfig.loginPassword),
            headers: {..._base, 'X-Device-Id': deviceId},
            body: jsonEncode({
              'phone': phone,
              'password': password,
              'userType': 'customer',
              'deviceId': deviceId,
            }),
          )
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await _persistAuth(
          data['token'].toString(),
          data['refreshToken']?.toString(),
          (data['user'] ?? data) as Map<String, dynamic>,
          phone,
        );
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
    String? referralCode,
  }) async {
    try {
      final deviceId = await DeviceIdentityService.getDeviceId();
      final body = <String, dynamic>{
        'phone': phone,
        'password': password,
        'fullName': fullName,
        'userType': 'customer',
        'deviceId': deviceId,
      };
      if (email != null && email.isNotEmpty) body['email'] = email;
      if (referralCode != null && referralCode.trim().isNotEmpty) {
        body['referralCode'] = referralCode.trim().toUpperCase();
      }
      final res = await http
          .post(
            Uri.parse(ApiConfig.registerAccount),
            headers: {..._base, 'X-Device-Id': deviceId},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await _persistAuth(
          data['token'].toString(),
          data['refreshToken']?.toString(),
          (data['user'] ?? data) as Map<String, dynamic>,
          phone,
        );
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

  static Future<Map<String, dynamic>> forgotPassword(String phone) async {
    try {
      final res = await http
          .post(
            Uri.parse(ApiConfig.forgotPassword),
            headers: _base,
            body: jsonEncode({'phone': phone, 'userType': 'customer'}),
          )
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body) as Map<String, dynamic>;
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

  static Future<Map<String, dynamic>> resetPassword(
    String phone,
    String otp,
    String newPassword,
  ) async {
    try {
      final res = await http
          .post(
            Uri.parse(ApiConfig.resetPassword),
            headers: _base,
            body: jsonEncode({
              'phone': phone,
              'otp': otp,
              'newPassword': newPassword,
              'userType': 'customer',
            }),
          )
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body) as Map<String, dynamic>;
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
