import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';
import '../main.dart' show navigatorKey;
import '../screens/splash_screen.dart';
import 'fcm_service.dart';

class AuthService {
  static const _tokenKey = 'auth_token';
  static const _userKey = 'user_data';
  static bool _handling401 = false;

  static Future<String?> getToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_tokenKey);
  }

  static Future<bool> isLoggedIn() async {
    final t = await getToken();
    return t != null && t.isNotEmpty;
  }

  static const Map<String, String> _base = {
    'Content-Type': 'application/json',
    'User-Agent': 'JAGOPro-Customer/1.0 (Android)',
    'Accept': 'application/json',
  };

  static Future<Map<String, String>> getHeaders() async {
    final token = await getToken();
    return {..._base, if (token != null) 'Authorization': 'Bearer $token'};
  }

  static Future<Map<String, dynamic>> sendOtp(String phone, [String userType = 'customer']) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.sendOtp),
        headers: _base,
        body: jsonEncode({'phone': phone, 'userType': userType}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body) as Map<String, dynamic>;
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<Map<String, dynamic>> verifyOtp(String phone, String otp, [String userType = 'customer']) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.verifyOtp),
        headers: _base,
        body: jsonEncode({'phone': phone, 'otp': otp, 'userType': userType}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_tokenKey, data['token']);
        final user = data['user'] ?? data;
        await prefs.setString(_userKey, jsonEncode(user));
        // Cache commonly accessed fields for quick reads
        final name = user['fullName'] ?? user['full_name'] ?? user['name'] ?? '';
        final userPhone = user['phone'] ?? phone;
        // CRITICAL: save user_id — socket_service.dart needs this to connect
        final userId = user['id']?.toString() ?? user['userId']?.toString() ?? user['user_id']?.toString() ?? '';
        if (name.toString().isNotEmpty) await prefs.setString('user_name', name.toString());
        if (userPhone.toString().isNotEmpty) await prefs.setString('user_phone', userPhone.toString());
        if (userId.isNotEmpty) await prefs.setString('user_id', userId);
        // Save FCM token to server after login
        FcmService().onLoginSuccess().catchError((_) {});
      }
      return data;
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<void> logout() async {
    try {
      final headers = await getHeaders();
      await http.post(Uri.parse(ApiConfig.logout), headers: headers)
          .timeout(const Duration(seconds: 30));
    } catch (_) {}
    await _clearStoredSession();
  }

  /// Call when server returns 401 — clears session and redirects to login.
  static Future<void> handle401() async {
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
      final res = await http.get(Uri.parse(ApiConfig.customerProfile), headers: headers)
          .timeout(const Duration(seconds: 30));
      if (res.statusCode == 200) return jsonDecode(res.body);
    } on TimeoutException {
      return null;
    } catch (_) {}
    return null;
  }

  static Future<Map<String, dynamic>> getProfileStatus() async {
    try {
      final headers = await getHeaders();
      final res = await http.get(Uri.parse(ApiConfig.customerProfile), headers: headers)
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
    await prefs.remove(_userKey);
    await prefs.remove('user_id');
    await prefs.remove('user_name');
    await prefs.remove('user_phone');
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
      final res = await http.patch(
        Uri.parse(ApiConfig.updateProfile),
        headers: headers,
        body: jsonEncode(body),
      ).timeout(const Duration(seconds: 30));
      return jsonDecode(res.body);
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<Map<String, dynamic>> loginWithPassword(String phone, String password) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.loginPassword),
        headers: _base,
        body: jsonEncode({'phone': phone, 'password': password, 'userType': 'customer'}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body);
      if (res.statusCode == 200 && data['token'] != null) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_tokenKey, data['token']);
        final user = data['user'] ?? data;
        await prefs.setString(_userKey, jsonEncode(user));
        final name = user['fullName'] ?? user['full_name'] ?? user['name'] ?? '';
        final userPhone = user['phone'] ?? phone;
        final userId = user['id']?.toString() ?? user['userId']?.toString() ?? user['user_id']?.toString() ?? '';
        if (name.toString().isNotEmpty) await prefs.setString('user_name', name.toString());
        if (userPhone.toString().isNotEmpty) await prefs.setString('user_phone', userPhone.toString());
        if (userId.isNotEmpty) await prefs.setString('user_id', userId);
        FcmService().onLoginSuccess().catchError((_) {});
      }
      return data;
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  /// Verify a Firebase ID token with our server and get our custom auth token.
  /// Call this after [FirebaseOtpService.verifyOtp] returns an ID token.
  static Future<Map<String, dynamic>> verifyFirebaseToken(String idToken, String phone, [String userType = 'customer']) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.verifyFirebaseToken),
        headers: _base,
        body: jsonEncode({'firebaseIdToken': idToken, 'phone': phone, 'userType': userType}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200 && data['token'] != null) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_tokenKey, data['token']);
        final user = data['user'] ?? data;
        await prefs.setString(_userKey, jsonEncode(user));
        final name = user['fullName'] ?? user['full_name'] ?? user['name'] ?? '';
        final userPhone = user['phone'] ?? phone;
        final userId = user['id']?.toString() ?? user['userId']?.toString() ?? user['user_id']?.toString() ?? '';
        if (name.toString().isNotEmpty) await prefs.setString('user_name', name.toString());
        if (userPhone.toString().isNotEmpty) await prefs.setString('user_phone', userPhone.toString());
        if (userId.isNotEmpty) await prefs.setString('user_id', userId);
        FcmService().onLoginSuccess().catchError((_) {});
      }
      return data;
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
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
      final body = {'phone': phone, 'password': password, 'fullName': fullName, 'userType': 'customer'};
      if (email != null && email.isNotEmpty) body['email'] = email;
      if (referralCode != null && referralCode.trim().isNotEmpty) {
        body['referralCode'] = referralCode.trim().toUpperCase();
      }
      final res = await http.post(Uri.parse(ApiConfig.registerAccount),
        headers: _base,
        body: jsonEncode(body))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      final data = jsonDecode(res.body);
      if (res.statusCode == 200 && data['token'] != null) {
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString(_tokenKey, data['token']);
        final user = data['user'] ?? data;
        await prefs.setString(_userKey, jsonEncode(user));
        final name = user['fullName'] ?? user['full_name'] ?? fullName;
        final userId = user['id']?.toString() ?? user['userId']?.toString() ?? user['user_id']?.toString() ?? '';
        if (name.toString().isNotEmpty) await prefs.setString('user_name', name.toString());
        await prefs.setString('user_phone', phone);
        if (userId.isNotEmpty) await prefs.setString('user_id', userId);
        FcmService().onLoginSuccess().catchError((_) {});
      }
      return data;
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<Map<String, dynamic>> resetPasswordWithFirebase(String firebaseIdToken, String phone, String newPassword) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.resetPasswordFirebase),
        headers: _base,
        body: jsonEncode({'firebaseIdToken': firebaseIdToken, 'phone': phone, 'newPassword': newPassword, 'userType': 'customer'}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body);
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<Map<String, dynamic>> forgotPassword(String phone) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.forgotPassword),
        headers: _base,
        body: jsonEncode({'phone': phone, 'userType': 'customer'}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body);
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }

  static Future<Map<String, dynamic>> resetPassword(String phone, String otp, String newPassword) async {
    try {
      final res = await http.post(Uri.parse(ApiConfig.resetPassword),
        headers: _base,
        body: jsonEncode({'phone': phone, 'otp': otp, 'newPassword': newPassword, 'userType': 'customer'}))
          .timeout(const Duration(seconds: 30));
      if (!(res.headers['content-type'] ?? '').contains('application/json')) {
        return {'success': false, 'message': 'Server error. Please try again.'};
      }
      return jsonDecode(res.body);
    } on TimeoutException {
      return {'success': false, 'message': 'Request timed out. Check your connection.'};
    } catch (e) {
      return {'success': false, 'message': 'Network error. Check your connection.'};
    }
  }
}
