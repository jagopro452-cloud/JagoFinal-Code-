import 'dart:async';
import 'package:just_audio/just_audio.dart';
import 'socket_service.dart';

/// Audio-only call service (socket relay-based, no WebRTC peer connection).
/// Maintains EXACT same public API as WebRTC version for UI compatibility.
class CallService {
  static final CallService _instance = CallService._internal();
  factory CallService() => _instance;
  CallService._internal();

  final SocketService _socket = SocketService();
  final AudioPlayer _audioPlayer = AudioPlayer();

  String? activeCallTripId;
  String? activeCallTargetId;
  DateTime? _callStartTime;

  // EXACT same streams as WebRTC version
  final _remoteStreamController = StreamController<dynamic>.broadcast();
  final _callStateController = StreamController<CallState>.broadcast();

  Stream<dynamic> get onRemoteStream => _remoteStreamController.stream;
  Stream<CallState> get onCallState => _callStateController.stream;

  CallState _state = CallState.idle;
  CallState get state => _state;

  final List<StreamSubscription> _subs = [];

  /// Initialize call service and attach socket listeners.
  void init() {
    if (_subs.isNotEmpty) return;
    _subs.add(_socket.onCallIncoming.listen(_handleIncoming));
    _subs.add(_socket.onCallOffer.listen(_handleOffer));
    _subs.add(_socket.onCallAnswer.listen(_handleAnswer));
    _subs.add(_socket.onCallIce.listen(_handleIce));
    _subs.add(_socket.onCallEnded.listen((_) => hangUp()));
    _subs.add(_socket.onCallRejected.listen((_) => _onCallRejected()));
  }

  /// Start an outgoing call to the target user.
  Future<void> startCall({
    required String targetUserId,
    required String tripId,
    required String callerName,
  }) async {
    if (_state != CallState.idle) return;
    activeCallTargetId = targetUserId;
    activeCallTripId = tripId;
    _setState(CallState.outgoing);

    // Signal via socket that call is starting
    _socket.initiateCall(
      targetUserId: targetUserId,
      tripId: tripId,
      callerName: callerName,
    );

    // For audio-only/relay, we also send a dummy offer to trigger state on other end
    _socket.sendCallOffer(
      targetUserId: targetUserId,
      sdp: {'type': 'offer', 'audio': true},
    );

    _callStartTime = DateTime.now();
  }

  /// Accept an incoming call.
  Future<void> acceptCall({
    required String callerId,
    required String tripId,
  }) async {
    // If state is idle but we have a callerId, force it to incoming to allow answering
    if (_state == CallState.idle && callerId.isNotEmpty) {
      activeCallTargetId = callerId;
      activeCallTripId = tripId;
      _setState(CallState.incoming);
    }
    
    if (_state != CallState.incoming) return;
    activeCallTargetId = callerId;
    activeCallTripId = tripId;
    await acceptIncomingCall();
  }

  /// Accept the pending incoming call offer.
  Future<void> acceptIncomingCall() async {
    if (activeCallTargetId != null) {
      _socket.sendCallAnswer(
        targetUserId: activeCallTargetId!,
        sdp: {'type': 'answer', 'audio': true},
      );
    }
    _callStartTime = DateTime.now();
    _setState(CallState.connected);
  }

  /// Reject an incoming call.
  void rejectIncomingCall() {
    if (activeCallTargetId != null) {
      _socket.rejectCall(
        targetUserId: activeCallTargetId!,
        tripId: activeCallTripId,
      );
    }
    _cleanup();
    _setState(CallState.idle);
  }

  /// Hang up the current call.
  Future<void> hangUp() async {
    if (activeCallTargetId != null) {
      int? dur;
      if (_callStartTime != null) {
        dur = DateTime.now().difference(_callStartTime!).inSeconds;
      }
      _socket.endCall(
        targetUserId: activeCallTargetId!,
        tripId: activeCallTripId,
        durationSec: dur,
      );
    }
    _cleanup();
    _setState(CallState.idle);
  }

  /// Mute or unmute the local microphone.
  void setMuted(bool muted) {
    // In a real implementation, would mute actual audio input
  }

  /// Switch between speaker and earpiece.
  Future<void> setSpeakerphone(bool enabled) async {
    // In a real implementation, would switch audio output
  }

  // ── Private handlers ───────────────────────────────────────────────────────

  void _handleIncoming(Map<String, dynamic> data) {
    if (_state == CallState.connected || _state == CallState.outgoing) return;
    activeCallTargetId = (data['callerId'] ?? data['senderId'] ?? data['userId'])?.toString();
    activeCallTripId = data['tripId']?.toString();
    _setState(CallState.incoming);
  }

  Future<void> _handleOffer(Map<String, dynamic> data) async {
    if (_state == CallState.connected || _state == CallState.outgoing) return;
    activeCallTargetId = data['callerId']?.toString();
    activeCallTripId = data['tripId']?.toString();
    // Show incoming call UI
    _setState(CallState.incoming);
  }

  Future<void> _handleAnswer(Map<String, dynamic> data) async {
    // Remote peer accepted the call
    if (_state == CallState.outgoing) {
      _callStartTime = DateTime.now();
      _setState(CallState.connected);
    }
  }

  Future<void> _handleIce(Map<String, dynamic> data) async {
    // For socket relay, ICE candidates not needed
  }

  void _onCallRejected() {
    _cleanup();
    _setState(CallState.rejected);
    Future.delayed(const Duration(seconds: 2), () {
      if (_state == CallState.rejected) _setState(CallState.idle);
    });
  }

  void _setState(CallState s) {
    _state = s;
    _callStateController.add(s);
  }

  void _cleanup() {
    _audioPlayer.stop();
    activeCallTargetId = null;
    activeCallTripId = null;
    _callStartTime = null;
    _remoteStreamController.add(null);
  }

  void dispose() {
    for (final s in _subs) { s.cancel(); }
    _subs.clear();
    _cleanup();
    _audioPlayer.dispose();
    _remoteStreamController.close();
    _callStateController.close();
  }
}

/// Call state enumeration (EXACT same as WebRTC version).
enum CallState { idle, outgoing, incoming, connected, rejected }
