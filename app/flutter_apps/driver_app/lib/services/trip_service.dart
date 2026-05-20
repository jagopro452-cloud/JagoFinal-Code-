import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../models/trip_model.dart';
import 'auth_service.dart';
import 'api_retry.dart';

Map<String, dynamic> _safeJson(http.Response res) {
  try {
    final ct = res.headers['content-type'] ?? '';
    if (!ct.contains('application/json')) return {'error': 'Invalid server response', 'statusCode': res.statusCode};
    return jsonDecode(res.body) as Map<String, dynamic>;
  } catch (_) {
    return {'error': 'Failed to parse response', 'statusCode': res.statusCode};
  }
}

class TripService {
  static Future<Map<String, dynamic>> getIncomingTrip() async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(Uri.parse(ApiConfig.driverIncomingTrip), headers: headers);
      return _safeJson(res);
    } catch (e) {
      return {'error': e.toString()};
    }
  }

  static Future<Map<String, dynamic>> acceptTrip(String tripId) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await apiRetry(
        () => http.post(Uri.parse(ApiConfig.driverAcceptTrip),
            headers: headers, body: jsonEncode({'tripId': tripId})),
        maxAttempts: 3,
      );
      return _safeJson(res);
    } catch (e) { return {'error': e.toString()}; }
  }

  static Future<Map<String, dynamic>> rejectTrip(String tripId) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await apiRetry(
        () => http.post(Uri.parse(ApiConfig.driverRejectTrip),
            headers: headers, body: jsonEncode({'tripId': tripId})),
      );
      return _safeJson(res);
    } catch (e) { return {'error': e.toString()}; }
  }

  static Future<Map<String, dynamic>> markArrived(String tripId) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await apiRetry(
        () => http.post(Uri.parse(ApiConfig.driverArrived),
            headers: headers, body: jsonEncode({'tripId': tripId})),
      );
      return _safeJson(res);
    } catch (e) { return {'error': e.toString()}; }
  }

  static Future<Map<String, dynamic>> verifyPickupOtp(String tripId, String otp) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await apiRetry(
        () => http.post(Uri.parse(ApiConfig.driverVerifyOtp),
            headers: headers, body: jsonEncode({'tripId': tripId, 'otp': otp})),
      );
      return _safeJson(res);
    } catch (e) { return {'error': e.toString()}; }
  }

  static Future<Map<String, dynamic>> completeTrip({
    required String tripId,
    required double actualFare,
    required double actualDistance,
    double tips = 0,
  }) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(Uri.parse(ApiConfig.driverCompleteTrip), headers: headers,
        body: jsonEncode({'tripId': tripId, 'actualFare': actualFare, 'actualDistance': actualDistance, 'tips': tips}));
      return _safeJson(res);
    } catch (e) { return {'error': e.toString()}; }
  }

  static Future<Map<String, dynamic>> cancelTrip(String tripId, String reason) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(Uri.parse(ApiConfig.driverCancelTrip), headers: headers, body: jsonEncode({'tripId': tripId, 'reason': reason}));
      return _safeJson(res);
    } catch (e) { return {'error': e.toString()}; }
  }

  static Future<Map<String, dynamic>> rateCustomer({required String tripId, required double rating, String? review}) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.post(Uri.parse(ApiConfig.driverRateCustomer), headers: headers,
        body: jsonEncode({'tripId': tripId, 'rating': rating, 'review': review ?? ''}));
      return _safeJson(res);
    } catch (e) { return {'error': e.toString()}; }
  }

  static Future<List<TripModel>> getTripHistory() async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(Uri.parse(ApiConfig.driverTrips), headers: headers);
      final data = _safeJson(res);
      final list = data['trips'] ?? data['data'] ?? [];
      return (list as List).map((t) => TripModel.fromJson(t)).toList();
    } catch (_) {
      return [];
    }
  }

  static Future<Map<String, dynamic>> getWallet() async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(Uri.parse(ApiConfig.driverWallet), headers: headers);
      return _safeJson(res);
    } catch (_) { return {'balance': 0, 'transactions': []}; }
  }

  static Future<Map<String, dynamic>> getEarnings(String period) async {
    try {
      final headers = await AuthService.getHeaders();
      final res = await http.get(Uri.parse('${ApiConfig.driverEarnings}?period=$period'), headers: headers);
      return _safeJson(res);
    } catch (_) { return {'total': 0, 'trips': 0}; }
  }
}
