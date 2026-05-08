import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:shared_preferences/shared_preferences.dart';
import '../config/api_config.dart';
import 'api_client.dart';
import 'auth_service.dart';

class SocketService {
  static final SocketService _instance = SocketService._internal();
  factory SocketService() => _instance;
  SocketService._internal();
  static const Duration _gpsStaleOfflineAfter = Duration(minutes: 2);
  static const Duration _heartbeatInterval = Duration(seconds: 12);
  static const String _activeTripKey = 'active_driver_trip_id';

  IO.Socket? _socket;
  bool _isConnected = false;
  bool _wasOnline = false;
  double? _lastLat;
  double? _lastLng;
  String? _activeTripId; // tracks current trip for room rejoin on reconnect
  DateTime? _lastLocationSentAt; // for auto-offline detection
  Timer? _heartbeatTimer;

  final _newTripController = StreamController<Map<String, dynamic>>.broadcast();
  final _tripCancelledController = StreamController<Map<String, dynamic>>.broadcast();
  final _tripStatusController = StreamController<Map<String, dynamic>>.broadcast();
  final _connectedController = StreamController<bool>.broadcast();
  final _tripTakenController = StreamController<Map<String, dynamic>>.broadcast();
  final _tripTimeoutController = StreamController<Map<String, dynamic>>.broadcast();
  final _chatMessageController = StreamController<Map<String, dynamic>>.broadcast();
  final _messageHistoryController = StreamController<Map<String, dynamic>>.broadcast();
  final _noDriversController = StreamController<Map<String, dynamic>>.broadcast();
  final _newParcelController = StreamController<Map<String, dynamic>>.broadcast();
  final _walletRechargedController = StreamController<Map<String, dynamic>>.broadcast();
  final _walletUpdatedController = StreamController<Map<String, dynamic>>.broadcast();
  final _driverStateChangedController = StreamController<Map<String, dynamic>>.broadcast();
  final _kycUpdatedController = StreamController<Map<String, dynamic>>.broadcast();
  final _serviceUpdatedController = StreamController<Map<String, dynamic>>.broadcast();
  final _configUpdatedController = StreamController<Map<String, dynamic>>.broadcast();
  final _poolNewPassengerController = StreamController<Map<String, dynamic>>.broadcast();
  final _poolSeatUpdateController = StreamController<Map<String, dynamic>>.broadcast();
  final _poolPassengerCancelledController = StreamController<Map<String, dynamic>>.broadcast();
  final _callIncomingController = StreamController<Map<String, dynamic>>.broadcast();
  final _callOfferController = StreamController<Map<String, dynamic>>.broadcast();
  final _callAnswerController = StreamController<Map<String, dynamic>>.broadcast();
  final _callIceController = StreamController<Map<String, dynamic>>.broadcast();
  final _callEndedController = StreamController<Map<String, dynamic>>.broadcast();
  final _callRejectedController = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get onNewTrip => _newTripController.stream;
  Stream<Map<String, dynamic>> get onTripCancelled => _tripCancelledController.stream;
  Stream<Map<String, dynamic>> get onTripStatus => _tripStatusController.stream;
  Stream<bool> get onConnectionChanged => _connectedController.stream;
  Stream<Map<String, dynamic>> get onTripTaken => _tripTakenController.stream;
  Stream<Map<String, dynamic>> get onTripTimeout => _tripTimeoutController.stream;
  Stream<Map<String, dynamic>> get onChatMessage => _chatMessageController.stream;
  Stream<Map<String, dynamic>> get onMessageHistory => _messageHistoryController.stream;
  Stream<Map<String, dynamic>> get onNoDrivers => _noDriversController.stream;
  Stream<Map<String, dynamic>> get onNewParcel => _newParcelController.stream;
  Stream<Map<String, dynamic>> get onWalletRecharged => _walletRechargedController.stream;
  Stream<Map<String, dynamic>> get onWalletUpdated => _walletUpdatedController.stream;
  Stream<Map<String, dynamic>> get onDriverStateChanged => _driverStateChangedController.stream;
  Stream<Map<String, dynamic>> get onKycUpdated => _kycUpdatedController.stream;
  Stream<Map<String, dynamic>> get onServiceUpdated => _serviceUpdatedController.stream;
  Stream<Map<String, dynamic>> get onConfigUpdated => _configUpdatedController.stream;
  Stream<Map<String, dynamic>> get onPoolNewPassenger => _poolNewPassengerController.stream;
  Stream<Map<String, dynamic>> get onPoolSeatUpdate => _poolSeatUpdateController.stream;
  Stream<Map<String, dynamic>> get onPoolPassengerCancelled => _poolPassengerCancelledController.stream;
  Stream<Map<String, dynamic>> get onCallIncoming => _callIncomingController.stream;
  Stream<Map<String, dynamic>> get onCallOffer => _callOfferController.stream;
  Stream<Map<String, dynamic>> get onCallAnswer => _callAnswerController.stream;
  Stream<Map<String, dynamic>> get onCallIce => _callIceController.stream;
  Stream<Map<String, dynamic>> get onCallEnded => _callEndedController.stream;
  Stream<Map<String, dynamic>> get onCallRejected => _callRejectedController.stream;
  bool get isConnected => _isConnected;
  bool get hasActiveTrip => (_activeTripId ?? '').isNotEmpty;

  Future<void> connect(String baseUrl) async {
    await _restoreActiveTripFromStorage();

    if (_socket != null) {
      if (_socket!.connected) return;
      _socket!.connect();
      return;
    }

    final prefs = await SharedPreferences.getInstance();
    var userId = prefs.getString('user_id') ?? '';
    final token = prefs.getString('auth_token') ?? '';

    // Recovery: existing installs before the user_id fix may have empty user_id.
    // Attempt to extract it from the saved user JSON so they don't need to reinstall.
    if (userId.isEmpty) {
      final userJson = prefs.getString('user_data') ?? '';
      if (userJson.isNotEmpty) {
        try {
          final user = jsonDecode(userJson) as Map<String, dynamic>;
          final recovered = user['id']?.toString() ??
              user['userId']?.toString() ??
              user['user_id']?.toString() ?? '';
          if (recovered.isNotEmpty) {
            await prefs.setString('user_id', recovered);
            userId = recovered;
          }
        } catch (_) {}
      }
    }

    if (userId.isEmpty) return;

    _socket = IO.io(
      baseUrl,
      IO.OptionBuilder()
          .setTransports(['websocket', 'polling'])
          .setQuery({'userId': userId, 'userType': 'driver', 'token': token})
          .enableAutoConnect()
          .enableReconnection()
          .setReconnectionAttempts(999)
          .setReconnectionDelay(3000)
          .build(),
    );

    _socket!.on('connect', (_) {
      _isConnected = true;
      _connectedController.add(true);
      print('[SOCKET][DRIVER] connected');
      _restoreSessionBindings();
    });

    // On reconnect after server restart: restore online status so driver stays visible
    _socket!.on('reconnect', (_) {
      print('[SOCKET][DRIVER] reconnected wasOnline=$_wasOnline activeTrip=$_activeTripId');
      if (_wasOnline) {
        _socket!.emit('driver:online', {
          'isOnline': true,
          if (_lastLat != null) 'lat': _lastLat,
          if (_lastLng != null) 'lng': _lastLng,
        });
      }
      // Rejoin active trip room so server routes trip events to this socket again
      if (_activeTripId != null) {
        _socket!.emit('driver:rejoin_trip', {'tripId': _activeTripId});
        // Also re-emit last location so server has fresh data for this trip
        if (_lastLat != null && _lastLng != null) {
          _socket!.emit('driver:location', {'lat': _lastLat, 'lng': _lastLng, 'heading': 0, 'speed': 0});
        }
      }
    });

    _socket!.on('disconnect', (_) {
      _isConnected = false;
      _connectedController.add(false);
      print('[SOCKET][DRIVER] disconnected');
    });

    _socket!.on('error:unauthorized', (_) async {
      final refreshed = await AuthService.refreshOnce();
      if (refreshed) {
        disconnect();
        await connect(baseUrl);
      }
    });

    _socket!.on('connect_error', (error) async {
      final errorText = error?.toString().toLowerCase() ?? '';
      if (!errorText.contains('unauthor')) return;
      final refreshed = await AuthService.refreshOnce();
      if (refreshed) {
        disconnect();
        await connect(baseUrl);
      }
    });

    _socket!.on('driver:online_ack', (data) {
      print('[SOCKET][DRIVER] online_ack $data');
    });

    _socket!.on('driver:heartbeat_ack', (data) {
      // Server confirmed Redis TTL refresh — no action needed
    });

    _socket!.on('trip:new_request', (data) {
      _newTripController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('trip:cancelled', (data) {
      _tripCancelledController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('trip:status_update', (data) {
      _tripStatusController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('trip:request_taken', (data) {
      _tripTakenController.add(Map<String, dynamic>.from(data));
    });

    // Backend emits 'trip:offer_timeout' when driver doesn't respond in time
    _socket!.on('trip:offer_timeout', (data) {
      _tripTimeoutController.add(Map<String, dynamic>.from(data));
    });
    // Also handle legacy event name
    _socket!.on('trip:timeout', (data) {
      _tripTimeoutController.add(Map<String, dynamic>.from(data));
    });

    // In-app chat message received (live)
    _socket!.on('trip:new_message', (data) {
      _chatMessageController.add(Map<String, dynamic>.from(data));
    });

    // Chat history loaded from DB on reconnect
    _socket!.on('trip:message_history', (data) {
      _messageHistoryController.add(Map<String, dynamic>.from(data));
    });

    // No available drivers found within all reassignment rounds
    _socket!.on('trip:no_drivers', (data) {
      _noDriversController.add(Map<String, dynamic>.from(data));
    });

    // Parcel delivery request
    _socket!.on('parcel:new_request', (data) {
      _newParcelController.add(Map<String, dynamic>.from(data));
    });

    // Wallet recharged (after Razorpay payment verified)
    _socket!.on('wallet:recharged', (data) {
      _walletRechargedController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('wallet:updated', (data) {
      _walletUpdatedController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('driver:state_changed', (data) {
      _driverStateChangedController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('kyc:updated', (data) {
      _kycUpdatedController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('service:updated', (data) {
      _serviceUpdatedController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('config:updated', (data) {
      if (data == null) return;
      _configUpdatedController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('pool:new_passenger', (data) {
      _poolNewPassengerController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('pool:seat_update', (data) {
      _poolSeatUpdateController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('pool:passenger_cancelled', (data) {
      _poolPassengerCancelledController.add(Map<String, dynamic>.from(data));
    });

    // ── WebRTC Call Signaling ──────────────────────────────────
    _socket!.on('call:incoming', (data) {
      _callIncomingController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('call:offer', (data) {
      _callOfferController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('call:answer', (data) {
      _callAnswerController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('call:ice', (data) {
      _callIceController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('call:ended', (data) {
      _callEndedController.add(Map<String, dynamic>.from(data));
    });
    _socket!.on('call:rejected', (data) {
      _callRejectedController.add(Map<String, dynamic>.from(data));
    });

    // Ping/pong: server pings driver to confirm still active; auto-respond immediately.
    // If driver misses 3 consecutive pings the server applies a penalty automatically.
    _socket!.on('ping_request', (data) {
      if (_isConnected) {
        _socket!.emit('ping_response', {
          'driverId': userId,
          if (data is Map && data['pingId'] != null) 'pingId': data['pingId'],
        });
      }
    });

    _socket!.connect();
    _startHeartbeat();
  }

  Future<void> _restoreActiveTripFromStorage() async {
    if ((_activeTripId ?? '').isNotEmpty) return;
    final prefs = await SharedPreferences.getInstance();
    final tripId = prefs.getString(_activeTripKey)?.trim() ?? '';
    if (tripId.isNotEmpty) {
      _activeTripId = tripId;
    }
  }

  void _restoreSessionBindings() {
    if (!_isConnected || _socket == null) return;
    if (_wasOnline) {
      _socket!.emit('driver:online', {
        'isOnline': true,
        if (_lastLat != null) 'lat': _lastLat,
        if (_lastLng != null) 'lng': _lastLng,
      });
    }
    if ((_activeTripId ?? '').isNotEmpty) {
      _socket!.emit('driver:rejoin_trip', {'tripId': _activeTripId});
      if (_lastLat != null && _lastLng != null) {
        _socket!.emit('driver:location', {
          'lat': _lastLat,
          'lng': _lastLng,
          'heading': 0,
          'speed': 0,
        });
      }
    }
  }

  /// Heartbeat: keeps server-side Redis presence TTL alive (35s TTL, 12s ping = safe margin).
  /// Also auto-offlines driver if GPS has been silent too long (no active trip).
  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      if (!_wasOnline || !_isConnected || _socket == null) return;

      // Refresh Redis TTL — include last known coords if available
      _socket!.emit('driver:heartbeat', {
        'ts': DateTime.now().millisecondsSinceEpoch,
        if (_lastLat != null) 'lat': _lastLat,
        if (_lastLng != null) 'lng': _lastLng,
      });

      // GPS staleness check: skip during active trip (GPS may legitimately lag)
      if (_activeTripId != null) return;
      final last = _lastLocationSentAt;
      if (last == null) return;
      if (DateTime.now().difference(last) >= _gpsStaleOfflineAfter) {
        _socket!.emit('driver:online', {'isOnline': false});
        _wasOnline = false;
        print('[SOCKET][DRIVER] auto-offline after stale GPS > ${_gpsStaleOfflineAfter.inSeconds}s');
      }
    });
  }

  /// Call when driver enters/exits a trip so socket can rejoin room on reconnect.
  /// Also joins the room immediately if connected.
  void setActiveTrip(String? tripId) {
    final normalized = tripId?.trim();
    _activeTripId = (normalized == null || normalized.isEmpty) ? null : normalized;
    _persistActiveTripId(_activeTripId);
    if (_activeTripId != null && _isConnected && _socket != null) {
      _socket!.emit('driver:rejoin_trip', {'tripId': _activeTripId});
    }
  }

  Future<void> _persistActiveTripId(String? tripId) async {
    final prefs = await SharedPreferences.getInstance();
    if (tripId == null || tripId.isEmpty) {
      await prefs.remove(_activeTripKey);
      return;
    }
    await prefs.setString(_activeTripKey, tripId);
  }

  void sendLocation({required double lat, required double lng, double heading = 0, double speed = 0}) {
    _lastLat = lat;
    _lastLng = lng;
    _lastLocationSentAt = DateTime.now();
    print('[SOCKET][DRIVER] sendLocation lat=$lat lng=$lng heading=$heading speed=$speed connected=$_isConnected');
    if (_isConnected) {
      _socket!.emit('driver:location', {
        'lat': lat,
        'lng': lng,
        'heading': heading,
        'speed': speed,
      });
      return;
    }
    _postLocationViaHttp(
      lat: lat,
      lng: lng,
      heading: heading,
      speed: speed,
    );
  }

  void sendParcelLocation({
    required String orderId,
    required double lat,
    required double lng,
  }) {
    if (!_isConnected || orderId.trim().isEmpty) return;
    try {
      _socket!.emit('driver:parcel_location', {
        'orderId': orderId,
        'lat': lat,
        'lng': lng,
      });
    } catch (_) {}
  }

  Future<void> _postLocationViaHttp({
    required double lat,
    required double lng,
    double heading = 0,
    double speed = 0,
  }) async {
    try {
      await const ApiClient().request(
        (headers) => http.post(
          Uri.parse(ApiConfig.driverLocation),
          headers: headers,
          body: jsonEncode({
            'lat': lat,
            'lng': lng,
            'heading': heading,
            'speed': speed,
            'isOnline': _wasOnline,
          }),
        ).timeout(const Duration(seconds: 10)),
        isActiveTrip: hasActiveTrip,
        source: 'driver_location_http_fallback',
      );
    } catch (_) {}
  }

  void setOnlineStatus({required bool isOnline, double? lat, double? lng}) {
    _wasOnline = isOnline;
    if (lat != null) _lastLat = lat;
    if (lng != null) _lastLng = lng;
    if (isOnline) {
      _lastLocationSentAt = DateTime.now();
    }
    print('[SOCKET][DRIVER] setOnlineStatus isOnline=$isOnline lat=$lat lng=$lng connected=$_isConnected');
    if (_isConnected) {
      _socket!.emit('driver:online', {
        'isOnline': isOnline,
        if (lat != null) 'lat': lat,
        if (lng != null) 'lng': lng,
      });
    } else {
      // Socket not connected — use HTTP fallback so go-online always works
      _setOnlineViaHttp(isOnline: isOnline, lat: lat, lng: lng);
    }
  }

  Future<void> _setOnlineViaHttp({required bool isOnline, double? lat, double? lng}) async {
    try {
      await const ApiClient().request(
        (headers) => http.patch(
          Uri.parse(ApiConfig.driverOnlineStatus),
          headers: headers,
          body: jsonEncode({
            'isOnline': isOnline,
            if (lat != null) 'lat': lat,
            if (lng != null) 'lng': lng,
          }),
        ).timeout(const Duration(seconds: 10)),
        isActiveTrip: hasActiveTrip,
        source: 'driver_online_status_http_fallback',
      );
    } catch (_) {}
  }

  void refreshOnlinePresence({double? lat, double? lng}) {
    if (!_wasOnline) return;
    print('[SOCKET][DRIVER] refreshOnlinePresence lat=${lat ?? _lastLat} lng=${lng ?? _lastLng}');
    setOnlineStatus(
      isOnline: true,
      lat: lat ?? _lastLat,
      lng: lng ?? _lastLng,
    );
  }

  Future<bool> acceptTrip(String tripId) async {
    if (!_isConnected) return false;
    final completer = Completer<bool>();

    // Safe complete guard — prevents double-completion race between ack and once listeners
    void safeComplete(bool value) {
      if (!completer.isCompleted) completer.complete(value);
    }

    _socket!.emitWithAck('driver:accept_trip', {'tripId': tripId}, ack: (data) {
      safeComplete(true);
    });
    _socket!.once('driver:accept_trip_ok', (_) => safeComplete(true));
    _socket!.once('driver:accept_trip_error', (_) => safeComplete(false));

    return completer.future.timeout(
      const Duration(seconds: 10),
      onTimeout: () {
        safeComplete(false);
        return false;
      },
    );
  }

  void updateTripStatus(String tripId, String status, {String? otp}) {
    if (!_isConnected) return;
    _socket!.emit('driver:trip_status', {
      'tripId': tripId,
      'status': status,
      if (otp != null) 'otp': otp,
    });
  }

  // Send in-app chat message (persisted to DB + relayed via socket)
  void sendChatMessage({required String tripId, required String message, required String senderName}) {
    if (!_isConnected) return;
    _socket!.emit('trip:send_message', {
      'tripId': tripId,
      'message': message,
      'senderName': senderName,
      'senderType': 'driver',
    });
  }

  // Load message history from DB (call after joining trip room)
  void loadChatHistory(String tripId) {
    if (!_isConnected) return;
    _socket!.emit('trip:get_messages', {'tripId': tripId});
  }

  // ── WebRTC Call Methods ──────────────────────────────────
  void initiateCall({required String targetUserId, required String tripId, required String callerName}) {
    if (!_isConnected) return;
    _socket!.emit('call:initiate', {'targetUserId': targetUserId, 'tripId': tripId, 'callerName': callerName});
  }

  void sendCallOffer({required String targetUserId, required String tripId, required dynamic sdp}) {
    if (!_isConnected) return;
    _socket!.emit('call:offer', {'targetUserId': targetUserId, 'tripId': tripId, 'sdp': sdp});
  }

  void sendCallAnswer({required String targetUserId, required String tripId, required dynamic sdp}) {
    if (!_isConnected) return;
    _socket!.emit('call:answer', {'targetUserId': targetUserId, 'tripId': tripId, 'sdp': sdp});
  }

  void sendIceCandidate({required String targetUserId, required String tripId, required dynamic candidate}) {
    if (!_isConnected) return;
    _socket!.emit('call:ice', {'targetUserId': targetUserId, 'tripId': tripId, 'candidate': candidate});
  }

  void endCall({required String targetUserId, String? tripId, int? durationSec}) {
    if (!_isConnected) return;
    _socket!.emit('call:end', {'targetUserId': targetUserId, if (tripId != null) 'tripId': tripId, if (durationSec != null) 'durationSec': durationSec});
  }

  void rejectCall({required String targetUserId, String? tripId}) {
    if (!_isConnected) return;
    _socket!.emit('call:reject', {'targetUserId': targetUserId, if (tripId != null) 'tripId': tripId});
  }

  void disconnect() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _socket?.disconnect();
    _socket = null;
    _isConnected = false;
  }

  void dispose() {
    disconnect();
    _newTripController.close();
    _tripCancelledController.close();
    _tripStatusController.close();
    _connectedController.close();
    _tripTakenController.close();
    _tripTimeoutController.close();
    _chatMessageController.close();
    _messageHistoryController.close();
    _newParcelController.close();
    _noDriversController.close();
    _walletRechargedController.close();
    _walletUpdatedController.close();
    _driverStateChangedController.close();
    _kycUpdatedController.close();
    _serviceUpdatedController.close();
    _configUpdatedController.close();
    _poolNewPassengerController.close();
    _poolSeatUpdateController.close();
    _poolPassengerCancelledController.close();
    _callIncomingController.close();
    _callOfferController.close();
    _callAnswerController.close();
    _callIceController.close();
    _callEndedController.close();
    _callRejectedController.close();
  }
}
