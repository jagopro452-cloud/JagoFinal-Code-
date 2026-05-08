import 'dart:async';
import 'dart:convert';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'package:shared_preferences/shared_preferences.dart';
import 'auth_service.dart';

class SocketService {
  static final SocketService _instance = SocketService._internal();
  factory SocketService() => _instance;
  SocketService._internal();

  IO.Socket? _socket;
  bool _isConnected = false;
  String? _activeTripId; // stored so we can re-join trip room after server restart
  String? _activeParcelId;
  String? _lastBaseUrl;

  final _driverAssignedController = StreamController<Map<String, dynamic>>.broadcast();
  final _driverLocationController = StreamController<Map<String, dynamic>>.broadcast();
  final _tripStatusController = StreamController<Map<String, dynamic>>.broadcast();
  final _tripCancelledController = StreamController<Map<String, dynamic>>.broadcast();
  final _connectedController = StreamController<bool>.broadcast();
  final _chatMessageController = StreamController<Map<String, dynamic>>.broadcast();
  final _messageHistoryController = StreamController<Map<String, dynamic>>.broadcast();
  final _noDriversController = StreamController<Map<String, dynamic>>.broadcast();
  final _tripSearchingController = StreamController<Map<String, dynamic>>.broadcast();
  final _paymentPendingController = StreamController<Map<String, dynamic>>.broadcast();
  final _parcelStatusController = StreamController<Map<String, dynamic>>.broadcast();
  final _parcelLocationController = StreamController<Map<String, dynamic>>.broadcast();
  final _poolMatchedController = StreamController<Map<String, dynamic>>.broadcast();
  final _poolSeatUpdateController = StreamController<Map<String, dynamic>>.broadcast();
  final _poolStatusController = StreamController<Map<String, dynamic>>.broadcast();
  final _configUpdatedController = StreamController<Map<String, dynamic>>.broadcast();
  final _callIncomingController = StreamController<Map<String, dynamic>>.broadcast();
  final _callOfferController = StreamController<Map<String, dynamic>>.broadcast();
  final _callAnswerController = StreamController<Map<String, dynamic>>.broadcast();
  final _callIceController = StreamController<Map<String, dynamic>>.broadcast();
  final _callEndedController = StreamController<Map<String, dynamic>>.broadcast();
  final _callRejectedController = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get onDriverAssigned => _driverAssignedController.stream;
  Stream<Map<String, dynamic>> get onDriverLocation => _driverLocationController.stream;
  Stream<Map<String, dynamic>> get onTripStatus => _tripStatusController.stream;
  Stream<Map<String, dynamic>> get onTripCancelled => _tripCancelledController.stream;
  Stream<bool> get onConnectionChanged => _connectedController.stream;
  Stream<Map<String, dynamic>> get onChatMessage => _chatMessageController.stream;
  Stream<Map<String, dynamic>> get onMessageHistory => _messageHistoryController.stream;
  Stream<Map<String, dynamic>> get onNoDrivers => _noDriversController.stream;
  Stream<Map<String, dynamic>> get onTripSearching => _tripSearchingController.stream;
  Stream<Map<String, dynamic>> get onPaymentPending => _paymentPendingController.stream;
  Stream<Map<String, dynamic>> get onParcelStatus => _parcelStatusController.stream;
  Stream<Map<String, dynamic>> get onParcelLocation => _parcelLocationController.stream;
  Stream<Map<String, dynamic>> get onPoolMatched => _poolMatchedController.stream;
  Stream<Map<String, dynamic>> get onPoolSeatUpdate => _poolSeatUpdateController.stream;
  Stream<Map<String, dynamic>> get onPoolStatus => _poolStatusController.stream;
  Stream<Map<String, dynamic>> get onConfigUpdated => _configUpdatedController.stream;
  Stream<Map<String, dynamic>> get onCallIncoming => _callIncomingController.stream;
  Stream<Map<String, dynamic>> get onCallOffer => _callOfferController.stream;
  Stream<Map<String, dynamic>> get onCallAnswer => _callAnswerController.stream;
  Stream<Map<String, dynamic>> get onCallIce => _callIceController.stream;
  Stream<Map<String, dynamic>> get onCallEnded => _callEndedController.stream;
  Stream<Map<String, dynamic>> get onCallRejected => _callRejectedController.stream;
  bool get isConnected => _isConnected;

  Future<void> connect(String baseUrl) async {
    _lastBaseUrl = baseUrl;
    // If already connected, no need to create a new socket — but caller may
    // still call trackTrip() after this, which will work because _isConnected=true.
    if (_socket?.connected == true) return;

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
          .setQuery({'userId': userId, 'userType': 'customer', 'token': token})
          .enableAutoConnect()
          .enableReconnection()
          .setReconnectionAttempts(999)
          .setReconnectionDelay(3000)
          .build(),
    );

    _socket!.on('connect', (_) {
      _isConnected = true;
      _connectedController.add(true);
      // Re-join trip room on every connect (first connect + reconnect after restart)
      if (_activeTripId != null) {
        _socket!.emit('customer:track_trip', {'tripId': _activeTripId});
      }
      if (_activeParcelId != null) {
        _socket!.emit('customer:track_parcel', {'orderId': _activeParcelId});
      }
    });

    // On reconnect after server restart: re-join active trip room so events resume
    _socket!.on('reconnect', (_) {
      if (_activeTripId != null) {
        _socket!.emit('customer:track_trip', {'tripId': _activeTripId});
      }
      if (_activeParcelId != null) {
        _socket!.emit('customer:track_parcel', {'orderId': _activeParcelId});
      }
    });

    _socket!.on('disconnect', (_) {
      _isConnected = false;
      _connectedController.add(false);
    });

    _socket!.on('connect_error', (err) async {
      _isConnected = false;
      _connectedController.add(false);
      final text = err?.toString().toLowerCase() ?? '';
      if (text.contains('unauthor')) {
        final refreshed = await AuthService.tryRefreshSession();
        if (refreshed && _lastBaseUrl != null) {
          disconnect();
          await connect(_lastBaseUrl!);
        }
      }
    });

    _socket!.on('error', (err) {
      _isConnected = false;
      _connectedController.add(false);
      print('[SOCKET] Error: $err');
    });

    _socket!.on('auth:error', (data) async {
      print('[SOCKET] Auth error: $data');
      _isConnected = false;
      _connectedController.add(false);
      final refreshed = await AuthService.tryRefreshSession();
      if (refreshed && _lastBaseUrl != null) {
        disconnect();
        await connect(_lastBaseUrl!);
        return;
      }
      await AuthService.handle401(source: 'customer_socket');
    });

    // Driver assigned to my trip (socket acceptance path)
    _socket!.on('trip:driver_assigned', (data) {
      _driverAssignedController.add(Map<String, dynamic>.from(data));
    });

    // Driver accepted my trip (HTTP acceptance path)
    _socket!.on('trip:accepted', (data) {
      final payload = Map<String, dynamic>.from(data);
      payload['driver'] = payload['driver'] is Map<String, dynamic>
          ? Map<String, dynamic>.from(payload['driver'])
          : {
              'id': payload['driverId'],
              'fullName': payload['driverName'],
              'phone': payload['driverPhone'],
              'rating': payload['driverRating'],
              'photo': payload['driverPhoto'],
              'vehicleNumber': payload['driverVehicleNumber'],
              'vehicleModel': payload['driverVehicleModel'],
              'vehicleCategory': payload['vehicleName'],
              'lat': payload['lat'],
              'lng': payload['lng'],
            };
      payload['eventType'] = 'trip_accepted';
      _driverAssignedController.add(payload);
      // Keep status stream in sync for tracking UI updates
      _tripStatusController.add({
        'tripId': payload['tripId'],
        'status': 'accepted',
        if (payload['pickupOtp'] != null) 'otp': payload['pickupOtp'],
      });
    });

    // Real-time driver GPS location
    _socket!.on('driver:location_update', (data) {
      _driverLocationController.add(Map<String, dynamic>.from(data));
    });

    // Trip status changed (arrived, in_progress, completed, cancelled)
    _socket!.on('trip:status_update', (data) {
      if (data == null) return;
      try {
        _tripStatusController.add(Map<String, dynamic>.from(data));
      } catch (e) {
        print('[SOCKET] Error processing trip:status_update: $e');
      }
    });

    // Some server paths emit completed directly instead of status_update
    _socket!.on('trip:completed', (data) {
      if (data == null) return;
      try {
        final payload = Map<String, dynamic>.from(data);
        _tripStatusController.add({
          'tripId': payload['tripId'],
          'status': 'completed',
          // Pass through wallet payment info so tracking screen can show correct payment UI
          if (payload['walletPendingAmount'] != null) 'walletPendingAmount': payload['walletPendingAmount'],
          if (payload['walletPaidAmount'] != null) 'walletPaidAmount': payload['walletPaidAmount'],
          if (payload['requiresCashPayment'] != null) 'requiresCashPayment': payload['requiresCashPayment'],
          if (payload['fare'] != null) 'fare': payload['fare'],
          if (payload['userPayable'] != null) 'userPayable': payload['userPayable'],
        });
      } catch (e) {
        print('[SOCKET] Error processing trip:completed: $e');
      }
    });

    // Trip cancelled by driver
    _socket!.on('trip:cancelled', (data) {
      _tripCancelledController.add(Map<String, dynamic>.from(data));
    });

    // In-app chat message received (live)
    _socket!.on('trip:new_message', (data) {
      _chatMessageController.add(Map<String, dynamic>.from(data));
    });

    // Chat history loaded from DB on reconnect
    _socket!.on('trip:message_history', (data) {
      _messageHistoryController.add(Map<String, dynamic>.from(data));
    });

    // No drivers found — trip auto-cancelled
    _socket!.on('trip:no_drivers', (data) {
      _noDriversController.add(Map<String, dynamic>.from(data));
      // Also push as cancelled so tracking screen updates
      _tripCancelledController.add({...Map<String, dynamic>.from(data), 'reason': 'no_drivers'});
    });

    _socket!.on('config:updated', (data) {
      if (data == null) return;
      _configUpdatedController.add(Map<String, dynamic>.from(data));
    });

    // Trip re-searching after driver rejected
    _socket!.on('trip:searching', (data) {
      _tripSearchingController.add(Map<String, dynamic>.from(data));
    });

    // Trip timeout — server gave up finding driver
    _socket!.on('trip:timeout', (data) {
      _noDriversController.add(Map<String, dynamic>.from(data));
      _tripCancelledController.add({...Map<String, dynamic>.from(data), 'reason': 'timeout'});
    });

    // Payment not yet verified — trip held at payment_pending
    _socket!.on('trip:payment_pending', (data) {
      _paymentPendingController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('parcel:driver_assigned', (data) {
      final payload = Map<String, dynamic>.from(data);
      payload['status'] = 'driver_assigned';
      _parcelStatusController.add(payload);
    });

    _socket!.on('parcel:in_transit', (data) {
      final payload = Map<String, dynamic>.from(data);
      payload['status'] = 'in_transit';
      _parcelStatusController.add(payload);
    });

    _socket!.on('parcel:completed', (data) {
      final payload = Map<String, dynamic>.from(data);
      payload['status'] = 'completed';
      _parcelStatusController.add(payload);
    });

    _socket!.on('parcel:cancelled', (data) {
      final payload = Map<String, dynamic>.from(data);
      payload['status'] = 'cancelled';
      _parcelStatusController.add(payload);
    });

    _socket!.on('parcel:driver_location', (data) {
      _parcelLocationController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('pool:matched', (data) {
      _poolMatchedController.add(Map<String, dynamic>.from(data));
      _poolStatusController.add({
        ...Map<String, dynamic>.from(data),
        'status': 'matched',
      });
    });

    _socket!.on('pool:seat_update', (data) {
      _poolSeatUpdateController.add(Map<String, dynamic>.from(data));
    });

    _socket!.on('pool:driver_location', (data) {
      _poolStatusController.add({
        ...Map<String, dynamic>.from(data),
        'status': 'driver_location',
      });
    });

    _socket!.on('pool:picked_up', (data) {
      _poolStatusController.add({
        ...Map<String, dynamic>.from(data),
        'status': 'picked_up',
      });
    });

    _socket!.on('pool:dropped', (data) {
      _poolStatusController.add({
        ...Map<String, dynamic>.from(data),
        'status': 'dropped',
      });
    });

    _socket!.on('pool:cancelled', (data) {
      _poolStatusController.add({
        ...Map<String, dynamic>.from(data),
        'status': 'cancelled',
      });
    });

    _socket!.on('pool:search_timeout', (data) {
      _poolStatusController.add({
        ...Map<String, dynamic>.from(data),
        'status': 'search_timeout',
      });
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

    _socket!.connect();
  }

  // Start tracking a specific trip (also stored for reconnect recovery).
  // Emits immediately if connected; the stored ID ensures re-join on reconnect.
  void trackTrip(String tripId) {
    _activeTripId = tripId;
    // Always emit if socket exists (even if _isConnected flag not yet set)
    if (_socket != null && (_isConnected || _socket!.connected)) {
      _socket!.emit('customer:track_trip', {'tripId': tripId});
    }
    // If socket not ready yet, the connect handler will pick it up via _activeTripId
  }

  void stopTrackingTrip(String tripId) {
    if (_socket != null && _socket!.connected) {
      _socket!.emit('customer:leave_trip', {'tripId': tripId});
    }
    _activeTripId = null;
  }

  void trackParcel(String orderId) {
    _activeParcelId = orderId;
    if (_socket != null && (_isConnected || _socket!.connected)) {
      _socket!.emit('customer:track_parcel', {'orderId': orderId});
    }
  }

  void stopTrackingParcel(String orderId) {
    if (_socket != null && _socket!.connected) {
      _socket!.emit('customer:leave_parcel', {'orderId': orderId});
    }
    if (_activeParcelId == orderId) {
      _activeParcelId = null;
    }
  }

  // Cancel a trip
  void cancelTrip(String tripId) {
    if (!_isConnected) return;
    _socket!.emit('customer:cancel_trip', {'tripId': tripId});
  }

  // Send in-app chat message (persisted to DB + relayed via socket)
  void sendChatMessage({required String tripId, required String message, required String senderName}) {
    if (!_isConnected) return;
    _socket!.emit('trip:send_message', {
      'tripId': tripId,
      'message': message,
      'senderName': senderName,
      'senderType': 'customer',
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
    _socket?.disconnect();
    _socket = null;
    _isConnected = false;
  }

  void dispose() {
    disconnect();
    _driverAssignedController.close();
    _driverLocationController.close();
    _tripStatusController.close();
    _tripCancelledController.close();
    _connectedController.close();
    _chatMessageController.close();
    _messageHistoryController.close();
    _noDriversController.close();
    _tripSearchingController.close();
    _paymentPendingController.close();
    _parcelStatusController.close();
    _parcelLocationController.close();
    _poolMatchedController.close();
    _poolSeatUpdateController.close();
    _poolStatusController.close();
    _configUpdatedController.close();
    _callIncomingController.close();
    _callOfferController.close();
    _callAnswerController.close();
    _callIceController.close();
    _callEndedController.close();
    _callRejectedController.close();
  }
}
