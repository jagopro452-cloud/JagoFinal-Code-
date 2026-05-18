import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../config/api_config.dart';
import '../../config/jago_theme.dart';
import '../../services/auth_service.dart';
import 'pending_verification_screen.dart';

class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key});
  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final PageController _pageController = PageController();
  int _currentStep = 0;
  bool _loading = false;
  String _uploadStatusText = '';

  // Step 1: Basic Info
  final _nameCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  DateTime? _dob;
  final _cityCtrl = TextEditingController();

  // Step 2: Password setup
  final _passwordCtrl = TextEditingController();
  final _confirmPasswordCtrl = TextEditingController();
  bool _accountCreated = false;

  // Step 3: Driving License
  final _licenseNumCtrl = TextEditingController();
  DateTime? _licenseExpiry;
  File? _dlFront;
  File? _dlBack;

  // Step 4: Vehicle Details
  final _vehicleBrandCtrl = TextEditingController();
  final _vehicleModelCtrl = TextEditingController();
  final _vehicleColorCtrl = TextEditingController();
  final _vehicleYearCtrl = TextEditingController();
  final _vehicleNumCtrl = TextEditingController();
  String _vehicleType = 'bike';

  // Step 5: Vehicle Documents
  File? _rcPhoto;
  File? _insurancePhoto;
  File? _vehicleFrontPhoto;

  // Step 6: Selfie
  File? _selfiePhoto;

  final _picker = ImagePicker();

  @override
  void initState() {
    super.initState();
    _prefillPhone();
  }

  Future<void> _prefillPhone() async {
    final prefs = await SharedPreferences.getInstance();
    setState(() {
      _phoneCtrl.text = prefs.getString('user_phone') ?? '';
    });
  }

  @override
  void dispose() {
    _pageController.dispose();
    _nameCtrl.dispose(); _phoneCtrl.dispose(); _cityCtrl.dispose();
    _passwordCtrl.dispose(); _confirmPasswordCtrl.dispose();
    _licenseNumCtrl.dispose(); _vehicleBrandCtrl.dispose();
    _vehicleModelCtrl.dispose(); _vehicleColorCtrl.dispose();
    _vehicleYearCtrl.dispose(); _vehicleNumCtrl.dispose();
    super.dispose();
  }

  void _showSnack(String msg, {bool error = false}) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(msg),
      backgroundColor: error ? JT.error : JT.primary,
      behavior: SnackBarBehavior.floating,
    ));
  }

  Future<void> _createDriverAccountForOnboarding() async {
    final phone = _phoneCtrl.text.trim();
    final password = _passwordCtrl.text;
    final confirmPassword = _confirmPasswordCtrl.text;
    if (phone.length != 10) {
      _showSnack('Enter a valid 10-digit phone number', error: true);
      return;
    }
    if (password.length < 8) {
      _showSnack('Password must be at least 8 characters', error: true);
      return;
    }
    if (password != confirmPassword) {
      _showSnack('Passwords do not match', error: true);
      return;
    }
    setState(() => _loading = true);
    final authRes = await AuthService.registerWithPassword(
      phone,
      password,
      _nameCtrl.text.trim(),
      vehicleNumber: _vehicleNumCtrl.text.trim().toUpperCase(),
      vehicleModel: _vehicleModelCtrl.text.trim(),
    );
    if (!mounted) return;
    setState(() => _loading = false);
    if (authRes['success'] == true || authRes['token'] != null) {
      setState(() => _accountCreated = true);
      _showSnack('Account created. Continue onboarding.');
      return;
    }
    _showSnack(authRes['message']?.toString() ?? 'Could not create account', error: true);
  }

  Widget _requiredLabel(String label, {bool required = true}) {
    return RichText(
      text: TextSpan(
        style: JT.body,
        children: [
          TextSpan(text: label),
          if (required)
            const TextSpan(
              text: ' *',
              style: TextStyle(
                color: JT.error,
                fontWeight: FontWeight.w700,
              ),
            ),
        ],
      ),
    );
  }

  Future<ImageSource?> _chooseImageSource(String type) async {
    final isSelfie = type == 'selfie';
    return showModalBottomSheet<ImageSource>(
      context: context,
      backgroundColor: JT.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (context) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(height: 12),
              Container(
                width: 42,
                height: 4,
                decoration: BoxDecoration(
                  color: JT.border,
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                isSelfie ? 'Choose Selfie Photo' : 'Choose Document Photo',
                style: JT.h3,
              ),
              const SizedBox(height: 8),
              Text(
                isSelfie
                    ? 'Use camera or gallery for a clear selfie.'
                    : 'Use camera or gallery for a clear upload.',
                style: JT.body,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              ListTile(
                leading: const Icon(Icons.camera_alt, color: JT.primary),
                title: Text(
                  isSelfie ? 'Take Photo' : 'Open Camera',
                  style: JT.bodyPrimary,
                ),
                onTap: () => Navigator.pop(
                  context,
                  ImageSource.camera,
                ),
              ),
              ListTile(
                leading: const Icon(Icons.photo_library, color: JT.primary),
                title: Text(
                  'Choose from Gallery',
                  style: JT.bodyPrimary,
                ),
                onTap: () => Navigator.pop(
                  context,
                  ImageSource.gallery,
                ),
              ),
              const SizedBox(height: 12),
            ],
          ),
        );
      },
    );
  }

  void _assignPickedFile(String type, File file) {
    setState(() {
      if (type == 'dl_front') _dlFront = file;
      if (type == 'dl_back') _dlBack = file;
      if (type == 'rc') _rcPhoto = file;
      if (type == 'insurance') _insurancePhoto = file;
      if (type == 'vehicle') _vehicleFrontPhoto = file;
      if (type == 'selfie') _selfiePhoto = file;
    });
  }

  Future<void> _pickImage(String type) async {
    try {
      final source = await _chooseImageSource(type);
      if (source == null) return;

      final picked = await _picker.pickImage(
        source: source,
        preferredCameraDevice: type == 'selfie' ? CameraDevice.front : CameraDevice.rear,
        imageQuality: type == 'selfie' ? 55 : 62,
        maxWidth: type == 'selfie' ? 900 : 1080,
        maxHeight: type == 'selfie' ? 900 : 1080,
      );
      if (picked == null) return;

      final file = File(picked.path);
      final sizeBytes = await file.length();
      if (sizeBytes > 5 * 1024 * 1024) {
        _showSnack('Photo is too large. Please choose a smaller image.', error: true);
        return;
      }
      _assignPickedFile(type, file);
    } catch (e) {
      _showSnack('Could not pick image. Please try again.', error: true);
    }
  }

  String _friendlyUploadError(Object error) {
    final rawMessage = error.toString().replaceFirst('Exception: ', '').trim();
    final parts = rawMessage.split(':');
    final hasDocPrefix = parts.length > 1;
    final docPrefix = hasDocPrefix ? '${parts.first.trim()}: ' : '';
    final message = rawMessage.toLowerCase();
    if (message.contains('session expired') || message.contains('login again')) {
      return '${docPrefix}Session expired. Please login again.';
    }
    if (message.contains('failed to update registration details') || message.contains('failed to update profile')) {
      return '${docPrefix}Could not save your registration details. Please check all fields and retry.';
    }
    if (message.contains('full name')) return '${docPrefix}Please enter your full name correctly.';
    if (message.contains('license number')) return '${docPrefix}Please enter your license number correctly.';
    if (message.contains('license expiry')) return '${docPrefix}Please select a valid license expiry date.';
    if (message.contains('vehicle type')) return '${docPrefix}Please select your vehicle type.';
    if (message.contains('unsupported')) return '${docPrefix}Unsupported image format. Please take a fresh photo.';
    if (message.contains('network') || message.contains('socket') || message.contains('connection')) {
      return '${docPrefix}Network issue, please retry.';
    }
    if (message.contains('timeout')) return '${docPrefix}Server temporarily unavailable. Please retry.';
    if (message.contains('face')) return '${docPrefix}Face not detected properly. Please retake your selfie.';
    if (message.contains('upload')) return '${docPrefix}Image upload failed. Please retry.';
    return '${docPrefix}Server temporarily unavailable. Please retry.';
  }

  Future<void> _uploadDocumentMultipart(
    String docType,
    File file, {
    String? expiryDate,
  }) async {
    final token = await AuthService.getToken();
    if (token == null || token.isEmpty) {
      throw Exception('Session expired. Please login again.');
    }

    final fileName = file.path.split(Platform.pathSeparator).last;
    final length = await file.length();
    if (length <= 0) {
      throw Exception('Image upload failed');
    }

    Object? lastError;
    for (var attempt = 1; attempt <= 3; attempt++) {
      try {
        if (mounted) {
          setState(() {
            _uploadStatusText = 'Uploading ${_docLabel(docType)} ($attempt/3)...';
          });
        }

        final request = http.MultipartRequest(
          'POST',
          Uri.parse(ApiConfig.uploadDocument),
        );
        request.headers.addAll({
          'Authorization': 'Bearer $token',
          'Accept': 'application/json',
          'User-Agent': 'JAGOPro-Driver/1.0 (Android)',
          'x-device-model': Platform.operatingSystem,
          'x-os-version': Platform.operatingSystemVersion,
          'x-network-type': 'mobile_app',
        });
        request.fields['docType'] = docType;
        if (expiryDate != null && expiryDate.isNotEmpty) {
          request.fields['expiryDate'] = expiryDate;
        }
        request.files.add(await http.MultipartFile.fromPath(
          'document',
          file.path,
          filename: fileName,
        ));

        final streamed = await request.send().timeout(const Duration(seconds: 60));
        final response = await http.Response.fromStream(streamed);
        if (response.statusCode == 200) {
          return;
        }

        String message = 'Image upload failed';
        try {
          if ((response.headers['content-type'] ?? '').contains('application/json')) {
            final decoded = jsonDecode(response.body);
            if (decoded is Map && decoded['message'] != null) {
              message = decoded['message'].toString();
            }
          }
        } catch (_) {}
        if (docType == 'selfie' && message.toLowerCase().contains('image upload failed')) {
          throw Exception('Selfie upload failed. Please retake your selfie and retry.');
        }
        throw Exception(message);
      } on SocketException catch (e) {
        lastError = e;
      } on HttpException catch (e) {
        lastError = e;
      } on HandshakeException catch (e) {
        lastError = e;
      } on TimeoutException catch (e) {
        lastError = e;
      } catch (e) {
        lastError = e;
        final lower = e.toString().toLowerCase();
        if (!(lower.contains('network') || lower.contains('timeout') || lower.contains('temporarily unavailable'))) {
          rethrow;
        }
      }

      if (attempt < 3) {
        await Future.delayed(Duration(milliseconds: 500 * attempt));
      }
    }

    throw lastError ?? Exception('Image upload failed');
  }

  Future<void> _uploadDocumentBase64Fallback(
    String docType,
    File file, {
    String? expiryDate,
  }) async {
    final token = await AuthService.getToken();
    if (token == null || token.isEmpty) {
      throw Exception('Session expired. Please login again.');
    }

    if (mounted) {
      setState(() {
        _uploadStatusText = 'Retrying ${_docLabel(docType)} upload...';
      });
    }

    final bytes = await file.readAsBytes();
    if (bytes.isEmpty) {
      throw Exception('Image upload failed');
    }
    if (bytes.length > 8 * 1024 * 1024) {
      throw Exception('Image is too large. Please retake a smaller photo.');
    }

    final mimeType = _mimeTypeForFile(file.path);
    final encoded = base64Encode(bytes);
    final payload = 'data:$mimeType;base64,$encoded';

    final response = await http.post(
      Uri.parse('${ApiConfig.baseUrl}/api/app/driver/upload-document-base64'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'JAGOPro-Driver/1.0 (Android)',
        'x-device-model': Platform.operatingSystem,
        'x-os-version': Platform.operatingSystemVersion,
        'x-network-type': 'mobile_app',
      },
      body: jsonEncode({
        'docType': docType,
        'imageData': payload,
        if (expiryDate != null && expiryDate.isNotEmpty) 'expiryDate': expiryDate,
      }),
    ).timeout(const Duration(seconds: 60));

    if (response.statusCode == 200) {
      return;
    }

    String message = 'Image upload failed';
    try {
      if ((response.headers['content-type'] ?? '').contains('application/json')) {
        final decoded = jsonDecode(response.body);
        if (decoded is Map && decoded['message'] != null) {
          message = decoded['message'].toString();
        }
      }
    } catch (_) {}
    throw Exception('${_docLabel(docType)}: $message');
  }

  String _mimeTypeForFile(String path) {
    final lower = path.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.heic')) return 'image/heic';
    if (lower.endsWith('.heif')) return 'image/heif';
    return 'image/jpeg';
  }

  String _docLabel(String docType) {
    switch (docType) {
      case 'dl_front':
        return 'DL Front';
      case 'dl_back':
        return 'DL Back';
      case 'rc':
        return 'RC';
      case 'insurance':
        return 'Insurance';
      case 'vehicle_photo':
        return 'Vehicle Front Photo';
      case 'selfie':
        return 'Selfie';
      default:
        return docType;
    }
  }

  Future<void> _submit() async {
    setState(() => _loading = true);
    try {
      // Ensure driver has a password-based backend session before submit.
      String? token = await AuthService.getToken();
      if (token == null || token.isEmpty) {
        final phone = _phoneCtrl.text.trim();
        if (phone.length != 10) throw Exception('Enter a valid 10-digit phone number');
        if (mounted) {
          setState(() {
            _uploadStatusText = 'Creating your driver account...';
          });
        }
        final authRes = await AuthService.registerWithPassword(
          phone,
          _passwordCtrl.text,
          _nameCtrl.text.trim(),
          vehicleNumber: _vehicleNumCtrl.text.trim().toUpperCase(),
          vehicleModel: _vehicleModelCtrl.text.trim(),
        );
        if (!(authRes['success'] == true || authRes['token'] != null)) {
          throw Exception(authRes['message'] ?? 'Could not create driver session.');
        }
        _accountCreated = true;
        token = await AuthService.getToken();
        if (token == null || token.isEmpty) {
          throw Exception('Session expired. Please login again.');
        }
      }

      final authHeaders = await AuthService.getHeaders();
      final headers = {...authHeaders, 'Content-Type': 'application/json'};

      // 1. Update Profile Fields
      final profileRes = await http.patch(
        Uri.parse('${ApiConfig.baseUrl}/api/app/driver/update-registration'),
        headers: headers,
        body: jsonEncode({
          'name': _nameCtrl.text.trim(),
          'dob': _dob?.toIso8601String(),
          'city': _cityCtrl.text.trim(),
          'licenseNumber': _licenseNumCtrl.text.trim(),
          'licenseExpiry': _licenseExpiry?.toIso8601String(),
          'vehicleBrand': _vehicleBrandCtrl.text.trim(),
          'vehicleModel': _vehicleModelCtrl.text.trim(),
          'vehicleColor': _vehicleColorCtrl.text.trim(),
          'vehicleYear': int.tryParse(_vehicleYearCtrl.text.trim()),
          'vehicleNumber': _vehicleNumCtrl.text.trim().toUpperCase(),
          'vehicleType': _vehicleType,
        }),
      );

      if (profileRes.statusCode == 401 || profileRes.statusCode == 403) {
        throw Exception('Session expired. Please login again.');
      } else if (profileRes.statusCode != 200) {
        String msg = 'Failed to update profile';
        try {
          if ((profileRes.headers['content-type'] ?? '').contains('application/json')) {
            final decoded = jsonDecode(profileRes.body);
            msg = decoded['message'] ?? msg;
          }
        } catch (_) {}
        throw Exception(msg);
      }

      // 2. Upload Documents
      final docs = {
        'dl_front': _dlFront,
        'dl_back': _dlBack,
        'rc': _rcPhoto,
        'insurance': _insurancePhoto,
        'vehicle_photo': _vehicleFrontPhoto,
        'selfie': _selfiePhoto,
      };

      for (var entry in docs.entries) {
        if (entry.value != null) {
          final docLabel = _docLabel(entry.key);
          if (mounted) {
            setState(() {
              _uploadStatusText = 'Preparing $docLabel...';
            });
          }
          final expiryDate = (entry.key == 'dl_front' || entry.key == 'dl_back') && _licenseExpiry != null
              ? DateFormat('yyyy-MM-dd').format(_licenseExpiry!)
              : null;
          try {
            await _uploadDocumentMultipart(
              entry.key,
              entry.value!,
              expiryDate: expiryDate,
            );
          } catch (e) {
            final lower = e.toString().toLowerCase();
            final canFallback = lower.contains('temporarily unavailable') ||
                lower.contains('timeout') ||
                lower.contains('network') ||
                lower.contains('upload failed');
            if (!canFallback) {
              throw Exception('$docLabel upload failed. ${_friendlyUploadError(e)}');
            }
            await _uploadDocumentBase64Fallback(
              entry.key,
              entry.value!,
              expiryDate: expiryDate,
            );
          }
        }
      }

      if (!mounted) return;
      Navigator.pushAndRemoveUntil(context, MaterialPageRoute(builder: (_) => const PendingVerificationScreen()), (_) => false);
    } catch (e) {
      _showSnack(_friendlyUploadError(e), error: true);
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
          _uploadStatusText = '';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: JT.bg,
      appBar: AppBar(
        backgroundColor: JT.bg,
        elevation: 0,
        iconTheme: const IconThemeData(color: JT.textPrimary),
        title: Text('Step ${_currentStep + 1} of 6', style: JT.body.copyWith(color: JT.textPrimary)),
        systemOverlayStyle: const SystemUiOverlayStyle(
          statusBarColor: Colors.transparent,
          statusBarIconBrightness: Brightness.dark,
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(4),
          child: LinearProgressIndicator(
            value: (_currentStep + 1) / 6,
            backgroundColor: JT.border,
            valueColor: const AlwaysStoppedAnimation(JT.primary),
          ),
        ),
      ),
      body: PageView(
        controller: _pageController,
        physics: const NeverScrollableScrollPhysics(),
        children: [
          _buildStep1(), _buildStep2(), _buildStep3(),
          _buildStep4(), _buildStep5(), _buildStep6(),
        ],
      ),
      bottomNavigationBar: _buildBottomNav(),
    );
  }

  Widget _buildBottomNav() {
    return Container(
      padding: const EdgeInsets.all(24),
      color: JT.bg,
      child: Row(
        children: [
          if (_currentStep > 0)
            Expanded(
              child: OutlinedButton(
                onPressed: () {
                  _pageController.previousPage(duration: const Duration(milliseconds: 300), curve: Curves.easeInOut);
                  setState(() => _currentStep--);
                },
                style: OutlinedButton.styleFrom(
                  side: BorderSide(color: JT.border),
                  foregroundColor: JT.textPrimary,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: Text('Back', style: JT.body.copyWith(color: JT.textPrimary)),
              ),
            ),
          if (_currentStep > 0) const SizedBox(width: 16),
          Expanded(
            flex: 2,
            child: ElevatedButton(
              onPressed: _loading ? null : () async {
                if (_currentStep == 0) {
                  if (_nameCtrl.text.trim().length < 2) { _showSnack('Enter your full name', error: true); return; }
                  if (_phoneCtrl.text.trim().length != 10) { _showSnack('Enter a valid 10-digit phone number', error: true); return; }
                }
                if (_currentStep == 1) {
                  if (_passwordCtrl.text.length < 8) { _showSnack('Set a password with at least 8 characters', error: true); return; }
                  if (_passwordCtrl.text != _confirmPasswordCtrl.text) { _showSnack('Passwords do not match', error: true); return; }
                  if (!_accountCreated) {
                    await _createDriverAccountForOnboarding();
                    if (!_accountCreated) return;
                  }
                }
                if (_currentStep == 2) {
                  if (_licenseNumCtrl.text.trim().isEmpty) { _showSnack('Enter your license number', error: true); return; }
                  if (_licenseExpiry == null) { _showSnack('Select license expiry date', error: true); return; }
                  if (_dlFront == null) { _showSnack('Upload DL Front photo', error: true); return; }
                  if (_dlBack == null) { _showSnack('Upload DL Back photo', error: true); return; }
                }
                if (_currentStep == 3) {
                  if (_vehicleBrandCtrl.text.trim().isEmpty) { _showSnack('Enter vehicle brand', error: true); return; }
                  if (_vehicleModelCtrl.text.trim().isEmpty) { _showSnack('Enter vehicle model', error: true); return; }
                  if (_vehicleColorCtrl.text.trim().isEmpty) { _showSnack('Enter vehicle color', error: true); return; }
                  if (_vehicleYearCtrl.text.trim().isEmpty) { _showSnack('Enter vehicle year', error: true); return; }
                  if (_vehicleNumCtrl.text.trim().isEmpty) { _showSnack('Enter vehicle number', error: true); return; }
                }
                if (_currentStep == 4) {
                  if (_rcPhoto == null) { _showSnack('Upload RC photo', error: true); return; }
                  if (_insurancePhoto == null) { _showSnack('Upload Insurance photo', error: true); return; }
                  if (_vehicleFrontPhoto == null) { _showSnack('Upload Vehicle Front photo', error: true); return; }
                }
                if (_currentStep == 5) {
                  if (_selfiePhoto == null) { _showSnack('Take a selfie photo', error: true); return; }
                  _submit();
                  return;
                }
                _pageController.nextPage(duration: const Duration(milliseconds: 300), curve: Curves.easeInOut);
                setState(() => _currentStep++);
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: JT.primary,
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 16),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
              child: _loading
                  ? const CircularProgressIndicator(color: Colors.white)
                  : Text(_currentStep == 5 ? 'Submit Application' : 'Next'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStep1() {
    return _stepContainer('Basic Information', 'Tell us about yourself', [
      _input('Full Name', _nameCtrl, Icons.person),
      const SizedBox(height: 16),
      _phoneInput(),
      const SizedBox(height: 16),
      _datePicker('Date of Birth', _dob, (d) => setState(() => _dob = d)),
      const SizedBox(height: 16),
      _input('City', _cityCtrl, Icons.location_city),
    ]);
  }

  Widget _buildStep2() {
    return _stepContainer('Password Setup', 'Create a secure driver account before document upload', [
      Text('Mobile: +91 ${_phoneCtrl.text.trim()}', style: JT.body),
      const SizedBox(height: 16),
      _input('Password', _passwordCtrl, Icons.lock, obscure: true, required: true),
      const SizedBox(height: 16),
      _input('Confirm Password', _confirmPasswordCtrl, Icons.lock_outline, obscure: true, required: true),
      const SizedBox(height: 12),
      Text(
        _accountCreated
            ? 'Account created. Continue onboarding and submit documents for admin approval.'
            : 'Password must be at least 8 characters. OTP/Firebase verification is not used.',
        style: JT.body.copyWith(color: _accountCreated ? JT.success : JT.textSecondary),
      ),
    ]);
  }

  Widget _buildStep3() {
    return _stepContainer('Driving License', 'Verify your driving credentials', [
      _input('License Number', _licenseNumCtrl, Icons.badge),
      const SizedBox(height: 16),
      _datePicker('Expiry Date', _licenseExpiry, (d) => setState(() => _licenseExpiry = d)),
      const SizedBox(height: 24),
      _imageTile('DL Front Photo', _dlFront, () => _pickImage('dl_front')),
      const SizedBox(height: 12),
      _imageTile('DL Back Photo', _dlBack, () => _pickImage('dl_back')),
    ]);
  }

  Widget _buildStep4() {
    return _stepContainer('Vehicle Details', 'Tell us about your ride', [
      _input('Brand', _vehicleBrandCtrl, Icons.directions_car),
      const SizedBox(height: 16),
      _input('Model', _vehicleModelCtrl, Icons.model_training),
      const SizedBox(height: 16),
      Row(children: [
        Expanded(child: _input('Color', _vehicleColorCtrl, Icons.color_lens)),
        const SizedBox(width: 16),
        Expanded(child: _input('Year', _vehicleYearCtrl, Icons.calendar_today, keyboard: TextInputType.number)),
      ]),
      const SizedBox(height: 16),
      _input('Vehicle Number', _vehicleNumCtrl, Icons.numbers),
      const SizedBox(height: 16),
      _dropdown('Vehicle Type', _vehicleType, ['bike', 'auto', 'car', 'mini', 'sedan', 'suv', 'xl'], (v) => setState(() => _vehicleType = v!)),
    ]);
  }

  Widget _buildStep5() {
    return _stepContainer('Vehicle Documents', 'Upload RC and Insurance', [
      _imageTile('RC Photo', _rcPhoto, () => _pickImage('rc')),
      const SizedBox(height: 12),
      _imageTile('Insurance Photo', _insurancePhoto, () => _pickImage('insurance')),
      const SizedBox(height: 12),
      _imageTile('Vehicle Front Photo', _vehicleFrontPhoto, () => _pickImage('vehicle')),
    ]);
  }

  Widget _buildStep6() {
    return _stepContainer('Final Step', 'Take a clear selfie', [
      const SizedBox(height: 40),
      Center(
        child: GestureDetector(
          onTap: () => _pickImage('selfie'),
          child: Container(
            width: 200, height: 200,
            decoration: BoxDecoration(
              color: JT.surfaceAlt,
              shape: BoxShape.circle,
              border: Border.all(color: JT.primary, width: 2),
              image: _selfiePhoto != null
                  ? DecorationImage(image: FileImage(_selfiePhoto!), fit: BoxFit.cover)
                  : null,
            ),
            child: _selfiePhoto == null
                ? Icon(Icons.camera_alt, size: 50, color: JT.iconInactive)
                : null,
          ),
        ),
      ),
      const SizedBox(height: 24),
      Text(
        'Use camera or gallery. Make sure your face is clearly visible without glasses or hats.',
        textAlign: TextAlign.center,
        style: JT.body,
      ),
      if (_loading && _uploadStatusText.isNotEmpty) ...[
        const SizedBox(height: 16),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2, color: JT.primary),
            ),
            const SizedBox(width: 10),
            Flexible(
              child: Text(
                _uploadStatusText,
                textAlign: TextAlign.center,
                style: JT.body.copyWith(color: JT.primary),
              ),
            ),
          ],
        ),
      ],
    ]);
  }

  Widget _stepContainer(String title, String subtitle, List<Widget> children) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: JT.h1),
          const SizedBox(height: 4),
          Text(subtitle, style: JT.body),
          const SizedBox(height: 32),
          ...children,
        ],
      ),
    );
  }

  Widget _phoneInput() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          controller: _phoneCtrl,
          readOnly: false,
          enabled: true,
          keyboardType: TextInputType.phone,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
          style: JT.bodyPrimary,
          decoration: InputDecoration(
            label: _requiredLabel('Phone Number'),
            prefixIcon: const Icon(Icons.phone, color: JT.primary),
            filled: true,
            fillColor: JT.surfaceAlt,
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: JT.border)),
            enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: JT.border)),
            focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: JT.primary, width: 1.5)),
          ),
        ),
        if (_phoneCtrl.text.isNotEmpty && _phoneCtrl.text.length < 10)
          Padding(
            padding: const EdgeInsets.only(top: 4, left: 12),
            child: Text('Enter a valid 10-digit phone number', style: JT.caption.copyWith(color: JT.error)),
          ),
      ],
    );
  }

  Widget _input(String label, TextEditingController ctrl, IconData icon, {bool readOnly = false, bool obscure = false, Widget? suffix, TextInputType keyboard = TextInputType.text, bool required = true}) {
    return TextField(
      controller: ctrl, readOnly: readOnly, obscureText: obscure, keyboardType: keyboard,
      style: JT.bodyPrimary,
      decoration: InputDecoration(
        label: _requiredLabel(label, required: required),
        prefixIcon: Icon(icon, color: JT.primary),
        suffixIcon: suffix,
        filled: true,
        fillColor: JT.surfaceAlt,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: JT.border)),
        enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: JT.border)),
        focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: JT.primary, width: 1.5)),
      ),
    );
  }

  Widget _datePicker(String label, DateTime? value, Function(DateTime) onPick, {bool required = true}) {
    // Determine date range based on label
    bool isExpiry = label.toLowerCase().contains('expiry');
    bool isDOB = label.toLowerCase().contains('birth');
    
    DateTime initialDate;
    DateTime firstDate;
    DateTime lastDate;
    
    if (isDOB) {
      // Date of Birth: 18-80 years ago
      initialDate = DateTime.now().subtract(const Duration(days: 9855)); // ~27 years
      firstDate = DateTime(1940);
      lastDate = DateTime.now().subtract(const Duration(days: 6570)); // Minimum 18 years
    } else if (isExpiry) {
      // License/Document Expiry: Today to 10 years in future
      initialDate = DateTime.now().add(const Duration(days: 1095)); // 3 years default
      firstDate = DateTime.now();
      lastDate = DateTime.now().add(const Duration(days: 3650)); // 10 years future
    } else {
      // Default: past dates
      initialDate = DateTime.now();
      firstDate = DateTime(1950);
      lastDate = DateTime.now();
    }
    
    return ListTile(
      tileColor: JT.surfaceAlt,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: JT.border),
      ),
      leading: const Icon(Icons.calendar_month, color: JT.primary),
      title: _requiredLabel(label, required: required),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value == null ? 'Select Date' : DateFormat('dd MMM yyyy').format(value),
            style: JT.bodyPrimary,
          ),
          if (isExpiry && value != null) ...[
            const SizedBox(height: 4),
            Text(
              _getExpiryStatus(value),
              style: _getExpiryStatusStyle(value),
            ),
          ],
        ],
      ),
      onTap: () async {
        final d = await showDatePicker(
          context: context,
          initialDate: value ?? initialDate,
          firstDate: firstDate,
          lastDate: lastDate,
          builder: (context, child) => Theme(
            data: Theme.of(context).copyWith(
              colorScheme: const ColorScheme.light(
                primary: JT.primary,
                surface: Colors.white,
              ),
            ),
            child: child!,
          ),
        );
        if (d != null) onPick(d);
      },
    );
  }

  String _getExpiryStatus(DateTime expiryDate) {
    final now = DateTime.now();
    final diff = expiryDate.difference(now);
    
    if (diff.inDays < 0) {
      return 'EXPIRED ${diff.inDays.abs()} days ago';
    } else if (diff.inDays == 0) {
      return 'EXPIRES TODAY!';
    } else if (diff.inDays <= 30) {
      return 'Expires in ${diff.inDays} days';
    } else if (diff.inDays <= 365) {
      final months = (diff.inDays / 30).ceil();
      return 'Expires in $months months';
    } else {
      final years = (diff.inDays / 365).floor();
      return 'Expires in $years year${years > 1 ? 's' : ''}';
    }
  }

  TextStyle _getExpiryStatusStyle(DateTime expiryDate) {
    final now = DateTime.now();
    final diff = expiryDate.difference(now);
    
    if (diff.inDays < 0) {
      return TextStyle(fontSize: 11, fontWeight: FontWeight.w400, color: JT.error);
    } else if (diff.inDays <= 30) {
      return TextStyle(fontSize: 11, fontWeight: FontWeight.w400, color: const Color(0xFFF97316));
    }
    return TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: const Color(0xFF059669));
  }

  Widget _imageTile(String label, File? file, VoidCallback onTap, {bool required = true}) {
    return ListTile(
      tileColor: JT.surfaceAlt,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: JT.border),
      ),
      leading: const Icon(Icons.image, color: JT.primary),
      title: _requiredLabel(label, required: required),
      trailing: file != null
          ? Icon(Icons.check_circle, color: JT.success)
          : Text('Upload', style: JT.body.copyWith(color: JT.primary)),
      onTap: onTap,
    );
  }

  Widget _dropdown(String label, String value, List<String> options, Function(String?) onChange, {bool required = true}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 8),
          child: _requiredLabel(label, required: required),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: BoxDecoration(
            color: JT.surfaceAlt,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: JT.border),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<String>(
              value: value,
              isExpanded: true,
              dropdownColor: JT.surface,
              items: options.map((s) => DropdownMenuItem(
                value: s,
                child: Text(s.toUpperCase(), style: JT.bodyPrimary),
              )).toList(),
              onChanged: onChange,
            ),
          ),
        ),
      ],
    );
  }
}
