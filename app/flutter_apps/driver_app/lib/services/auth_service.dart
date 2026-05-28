import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';
import '../main.dart' show navigatorKey;
import '../models/user_model.dart';
import '../screens/splash_screen.dart';
import 'device_identity_service.dart';
import 'fcm_service.dart';

class AuthService {
  static const _tokenKey = 'auth_token';
  static const _refreshTokenKey = 'refresh_token';
  static const _userKey = 'user_data';
  static const _userNameKey = 'user_name';
  static const _userPhoneKey = 'user_phone';
  static const _userIdKey = 'user_id';

  static const Map<String, String> _base = {
    'Content-Type': 'application/json',
    'User-Agent': 'JAGOPro-Driver/1.0 (Android)',
    'Accept': 'application/json',
  };

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  static Future<void> saveToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token.trim());
  }

  static Future<void> saveRefreshToken(String? token) async {
    final prefs = await SharedPreferences.getInstance();
    final normalized = token?.trim() ?? '';
    if (normalized.isEmpty) {
      await prefs.remove(_refreshTokenKey);
      return;
    }
    await prefs.setString(_refreshTokenKey, normalized);
  }

  static Future<void> saveUser(Map<String, dynamic> userData) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_userKey, jsonEncode(userData));
    final name = userData['fullName'] ?? userData['full_name'] ?? userData['name'] ?? '';
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
    final str = prefs.getString(_userKey);
    if (str == null) return null;
    return jsonDecode(str) as Map<String, dynamic>;
  }

  static String? _extractTripId(dynamic payload) {
    if (payload is! Map) return null;
    final raw = payload['id'] ??
        payload['tripId'] ??
        payload['trip_id'] ??
        payload['activeTripId'] ??
        payload['active_trip_id'];
    return raw?.toString();
  }

  static Future<bool> isLoggedIn() async {
    final token = await getToken();
    return token != null && token.isNotEmpty;
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

  static Future<bool> rehydrateStoredSession({bool refreshProfile = true}) async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_tokenKey)?.trim() ?? '';
    if (token.isEmpty) return false;

    final savedUser = await getSavedUser();
    if (savedUser != null && savedUser.isNotEmpty) {
      await saveUser(savedUser);
    }

    if (!refreshProfile) return true;

    try {
      final res = await http
          .get(
            Uri.parse(ApiConfig.driverProfile),
            headers: {..._base, 'Authorization': 'Bearer $token'},
          )
          .timeout(const Duration(seconds: 8));

      if (res.statusCode == 200) {
        if ((res.headers['content-type'] ?? '').contains('application/json')) {
          final body = jsonDecode(res.body);
          if (body is Map<String, dynamic>) {
            await saveUser(body);
          }
        }
        return true;
      }

      if (res.statusCode == 401) {
        return refreshOnce();
      }
    } on TimeoutException {
      return true;
    } catch (_) {
      return true;
    }

    return true;
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
    await clearLocalSession();
  }

  static Future<bool> refreshOnce() {
    return _refreshSession();
  }

  static Future<String?> getActiveTripId() async {
    try {
      final headers = await getHeaders();
      final res = await http
          .get(Uri.parse(ApiConfig.driverActiveTrip), headers: headers)
          .timeout(const Duration(seconds: 8));
      if (res.statusCode != 200 ||
          !(res.headers['content-type'] ?? '').contains('application/json')) {
        return null;
      }

      final body = jsonDecode(res.body);
      if (body is! Map<String, dynamic>) return null;
      return _extractTripId(body['trip']) ??
          _extractTripId(body['activeTrip']) ??
          _extractTripId(body);
    } on TimeoutException {
      return null;
    } catch (_) {
      return null;
    }
  }

  static Future<bool> hasActiveTripSession() async {
    final tripId = await getActiveTripId();
    return tripId != null && tripId.isNotEmpty;
  }

  static Future<bool> safeLogout() async {
    if (await hasActiveTripSession()) {
      return false;
    }
    await logout();
    return true;
  }

  static Future<void> handle401({
    String source = 'driver_app',
    bool allowDuringActiveTrip = false,
  }) async {
    if (allowDuringActiveTrip && await hasActiveTripSession()) {
      return;
    }
    await clearLocalSession();
    navigatorKey.currentState?.pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const SplashScreen()),
      (route) => false,
    );
  }

  static Future<UserModel?> getProfile() async {
    try {
      final headers = await getHeaders();
      final res = await http
          .get(Uri.parse(ApiConfig.driverProfile), headers: headers)
          .timeout(const Duration(seconds: 30));
      if (res.statusCode == 200) {
        return UserModel.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
      }
    } on TimeoutException {
      return null;
    } catch (_) {}
    return null;
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
              'userType': 'driver',
              'deviceId': deviceId,
            }),
          )
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await saveToken(data['token'].toString());
        await saveRefreshToken(data['refreshToken']?.toString());
        await saveUser((data['user'] ?? data) as Map<String, dynamic>);
        FcmService().onLoginSuccess().catchError((_) {});
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
    String? vehicleNumber,
    String? vehicleModel,
    String? vehicleCategoryId,
    String? referralCode,
  }) async {
    try {
      final deviceId = await DeviceIdentityService.getDeviceId();
      final body = <String, dynamic>{
        'phone': phone,
        'password': password,
        'fullName': fullName,
        'userType': 'driver',
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
        await saveToken(data['token'].toString());
        await saveRefreshToken(data['refreshToken']?.toString());
        await saveUser((data['user'] ?? data) as Map<String, dynamic>);
        FcmService().onLoginSuccess().catchError((_) {});
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
            body: jsonEncode({'phone': phone, 'userType': 'driver'}),
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
              'userType': 'driver',
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

  static Future<bool> _refreshSession({bool clearOnFailure = true}) async {
    final prefs = await SharedPreferences.getInstance();
    final refreshToken = prefs.getString(_refreshTokenKey)?.trim() ?? '';
    if (refreshToken.isEmpty) {
      if (clearOnFailure) {
        await clearLocalSession();
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
          await clearLocalSession();
        }
        return false;
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        await saveToken(data['token'].toString());
        await saveRefreshToken(data['refreshToken']?.toString());
        return true;
      }
    } on TimeoutException {
      return false;
    } catch (_) {}

    if (clearOnFailure) {
      await clearLocalSession();
    }
    return false;
  }
}
