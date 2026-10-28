import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Modal, FlatList, Image, Animated, Easing } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { livenessFailureMessage, livenessCaption, wait } from '../utils/faceCapture';
import LiveFaceCamera, { discardCapture } from '../components/LiveFaceCamera';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow } from '../theme';
import { getDeviceInfo } from '../utils/device';
import { getDepartments, getEmployeeOptions } from '../api/client';
import FadeIn from '../components/FadeIn';
import PrimaryButton from '../components/PrimaryButton';
import { useResponsive, MAX_WIDTH, MODAL_ORIENTATIONS } from '../utils/responsive';

// Mirrors the backend's VALID_SUFFIXES list (controllers/employeeAuthController.js).
// '' (displayed as "None") is the default -- the field is optional.
const SUFFIX_OPTIONS = ['None', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];

// Fallbacks for /employee-auth/employee-options (match employeeOptionController.js).
const CLASSIFICATION_OPTIONS = [
  'Permanent Administrative', 'Permanent Academic', 'Casual Administrative',
  'COS Administrative', 'COS Academic', 'Job Order'
];

const POSITION_OPTIONS = [
  'Instructor I', 'Instructor II', 'Instructor III',
  'Assistant Professor', 'Associate Professor', 'Professor',
  'Department Dean', 'Program Chair', 'Guidance Counselor', 'Librarian',
  'Registrar Staff', 'Accounting Staff',
  'Administrative Aide I', 'Administrative Aide II', 'Administrative Aide III',
  'Administrative Officer', 'Administrative Assistant',
];

const GENDER_OPTIONS = ['Male', 'Female'];

// Maps a stored value to a list option, or to 'Others' with the raw text.
function resolveDropdownValue(raw, options) {
  if (!raw) return { selected: '', other: '' };
  return options.includes(raw) ? { selected: raw, other: '' } : { selected: 'Others', other: raw };
}

// Dropdown with an "Others" free-text option.
function DropdownFieldWithOthers({
  label, options, value, onSelect, otherValue, onOtherChange,
  pickerOpen, setPickerOpen, placeholder, otherPlaceholder, required
}) {
  return (
    <>
      <Text style={styles.inputLabel}>{label}{required ? ' *' : ''}</Text>
      <TouchableOpacity style={styles.dropdownInput} onPress={() => setPickerOpen(true)}>
        <Text style={value ? styles.dropdownValue : styles.dropdownPlaceholder}>{value || placeholder}</Text>
        <Text style={styles.dropdownCaret}>{'\u25BE'}</Text>
      </TouchableOpacity>
      {value === 'Others' && (
        <TextInput
          style={[styles.input, { marginTop: 8 }]}
          placeholder={otherPlaceholder}
          placeholderTextColor="#94A3B8"
          value={otherValue}
          onChangeText={onOtherChange}
          autoFocus
        />
      )}
      <Modal visible={pickerOpen} transparent animationType="fade" supportedOrientations={MODAL_ORIENTATIONS} onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>{label}</Text>
            <FlatList
              data={[...options, 'Others']}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalOption}
                  onPress={() => {
                    onSelect(item);
                    setPickerOpen(false);
                  }}
                >
                  <Text style={[styles.modalOptionText, item === value && styles.modalOptionTextActive]}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

// Face capture: hold steady, then blink (see utils/faceCapture.js).
const DETECTION_ATTEMPTS = 3; // retries allowed before aborting the whole capture

// Details -> Face Scan progress bar. `dark` for use over the camera.
function StepProgress({ current, labels, dark }) {
  const dotIdleBorder = dark ? 'rgba(255,255,255,0.4)' : colors.border;
  const dotIdleText = dark ? 'rgba(255,255,255,0.7)' : colors.textSub;
  const labelIdle = dark ? 'rgba(255,255,255,0.65)' : colors.textSub;
  const labelActive = dark ? '#fff' : colors.primary;
  const connectorIdle = dark ? 'rgba(255,255,255,0.25)' : colors.border;

  return (
    <View style={styles.stepProgressRow}>
      {labels.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const dotBorderColor = done ? colors.success : active ? colors.primary : dotIdleBorder;
        return (
          <React.Fragment key={label}>
            <View style={styles.stepProgressItem}>
              <View style={[styles.stepDot, { borderColor: dotBorderColor }, done && styles.stepDotActive, active && { backgroundColor: colors.primary }]}>
                {done ? (
                  <Text style={styles.stepDotCheck}>{'\u2713'}</Text>
                ) : (
                  <Text style={[styles.stepDotNum, { color: active ? '#fff' : dotIdleText }]}>{i + 1}</Text>
                )}
              </View>
              <Text style={[styles.stepLabel, { color: done || active ? labelActive : labelIdle }]}>{label}</Text>
            </View>
            {i < labels.length - 1 && (
              <View style={[styles.stepConnector, { backgroundColor: done ? colors.success : connectorIdle }]} />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}

// Google sign-in -> details (step 1) -> live face capture (step 2) ->
// POST /api/employee-auth/link-device.
export default function RegistrationScreen({ navigation }) {
  const { employee, pendingGoogle, completeRegistration, cancelRegistration } = useAuth();
  // Set on success: RootNavigator replaces this stack, so don't navigate or set state after.
  const registeredRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const [step, setStep] = useState('details'); // 'details' | 'capture'
  const { width, height, insets, isLandscape, isCompactHeight, topPad, contentStyle } = useResponsive();

  // -- Step 1: employee details --
  const [employeeCode, setEmployeeCode] = useState('');
  const [surname, setSurname] = useState('');
  const [givenName, setGivenName] = useState('');
  const [middleName, setMiddleName] = useState('');
  const [suffix, setSuffix] = useState('None');
  const [suffixPickerOpen, setSuffixPickerOpen] = useState(false);
  const [departments, setDepartments] = useState([]); // [{ id, name }]
  const [department, setDepartment] = useState(null); // selected department name
  const [departmentPickerOpen, setDepartmentPickerOpen] = useState(false);
  const [position, setPosition] = useState('');
  const [positionOther, setPositionOther] = useState('');
  const [positionPickerOpen, setPositionPickerOpen] = useState(false);
  const [gender, setGender] = useState('');
  const [genderOther, setGenderOther] = useState('');
  const [genderPickerOpen, setGenderPickerOpen] = useState(false);
  const [classification, setClassification] = useState('');
  const [classificationOther, setClassificationOther] = useState('');
  const [classificationPickerOpen, setClassificationPickerOpen] = useState(false);
  const [positionOptions, setPositionOptions] = useState(POSITION_OPTIONS);
  const [classificationOptions, setClassificationOptions] = useState(CLASSIFICATION_OPTIONS);
  const [deviceInfo, setDeviceInfo] = useState('Detecting device...');

  // -- Step 2: guided, real-time-verified face capture --
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [captureStage, setCaptureStage] = useState('ready'); // 'ready' | 'recording' | 'reviewing'
  // 'idle' | 'scanning' | 'confirmed' | 'failed' | 'finishing' -- drives the
  // real-time feedback UI (pulsing scan ring, success/fail pop, etc).
  const [stepStatus, setStepStatus] = useState('idle');
  // Latest per-frame status from the live camera -- drives the badge and caption.
  const [live, setLive] = useState({ phase: 'hold', faceDetected: false, hint: null, eyesClosed: false });
  const liveFaceDetected = live.faceDetected;
  const [cameraReady, setCameraReady] = useState(false);
  const [capturedVideoUri, setCapturedVideoUri] = useState(null); // set once the video selfie has finished writing
  const [capturedPhoto, setCapturedPhoto] = useState(null); // { uri, video } -- selfie still (used for the face embedding) + Promise of the video selfie's uri
  const scanPulse = useRef(new Animated.Value(0)).current; // looping "scanning" ring while stepStatus === 'scanning'
  const resultPop = useRef(new Animated.Value(0)).current; // spring pop for the confirmed/failed icon
  const verifyingRef = useRef(false); // lets handleCancelRecording interrupt an in-progress sequence

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [lockInfo, setLockInfo] = useState(null); // { message } -- set on a 423 DoubleSafe lockout response

  useEffect(() => {
    if (!pendingGoogle) {
      // Cleared because registration just finished (or the user is already
      // signed in): RootNavigator handles where to go next.
      if (registeredRef.current || employee) return;
      navigation.replace('Login');
      return;
    }
    const existing = pendingGoogle.existingEmployee;
    if (existing) {
      // Returning employee on a new device: pre-fill from their record.
      setEmployeeCode(existing.employee_code || '');
      setSurname(existing.surname || pendingGoogle.google?.family_name || '');
      setGivenName(existing.given_name || pendingGoogle.google?.given_name || '');
      setMiddleName(existing.middle_name || '');
      setSuffix(existing.suffix ? existing.suffix : 'None');
      setDepartment(existing.department || null);
      const posResolved = resolveDropdownValue(existing.position || '', POSITION_OPTIONS);
      setPosition(posResolved.selected);
      setPositionOther(posResolved.other);
      const genResolved = resolveDropdownValue(existing.gender || '', GENDER_OPTIONS);
      setGender(genResolved.selected);
      setGenderOther(genResolved.other);
      const classResolved = resolveDropdownValue(existing.classification || '', CLASSIFICATION_OPTIONS);
      setClassification(classResolved.selected);
      setClassificationOther(classResolved.other);
    } else {
      // Pre-fill the name from Google.
      setSurname(pendingGoogle.google?.family_name || '');
      setGivenName(pendingGoogle.google?.given_name || '');
    }
    (async () => {
      const info = getDeviceInfo();
      setDeviceInfo(`MODEL: ${info.model}\nBRAND: ${info.brand}\nOS: ${info.os}\nDEVICE ID: ${info.uid}`);
    })();
    (async () => {
      try {
        const res = await getDepartments();
        setDepartments(res.data || []);
      } catch (err) {
        // Non-fatal — the employee can still type/select once the list loads,
        // or retry; department is resolved/created server-side either way.
      }
    })();
    (async () => {
      try {
        const res = await getEmployeeOptions();
        const positions = Array.isArray(res.data?.positions) ? res.data.positions : POSITION_OPTIONS;
        const classifications = Array.isArray(res.data?.classifications) ? res.data.classifications : CLASSIFICATION_OPTIONS;
        if (!mountedRef.current) return;
        setPositionOptions(positions);
        setClassificationOptions(classifications);
        // A returning employee's values were matched against the fallback
        // lists above; match them again against the admin's current lists.
        if (existing) {
          const pos = resolveDropdownValue(existing.position || '', positions);
          setPosition(pos.selected);
          setPositionOther(pos.other);
          const cls = resolveDropdownValue(existing.classification || '', classifications);
          setClassification(cls.selected);
          setClassificationOther(cls.other);
        }
      } catch (err) {
        // Non-fatal — the built-in fallback lists stay in place.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGoogle]);

  const handleContinueToCapture = async () => {
    setErrorMsg('');
    // Every field on this form is required except Middle Name and Suffix.
    if (!employeeCode.trim() || !surname.trim() || !givenName.trim()) {
      setErrorMsg('Employee ID, Surname, and Given Name are required.');
      return;
    }
    if (!department) {
      setErrorMsg('Please select a Department.');
      return;
    }
    if (!position) {
      setErrorMsg('Please select a Position.');
      return;
    }
    if (!gender) {
      setErrorMsg('Please select a Gender.');
      return;
    }
    if (!classification) {
      setErrorMsg('Please select a Classification.');
      return;
    }
    // "Others" requires a value.
    if (position === 'Others' && !positionOther.trim()) {
      setErrorMsg('Please specify your Position, or choose one from the list.');
      return;
    }
    if (gender === 'Others' && !genderOther.trim()) {
      setErrorMsg('Please specify your Gender, or choose one from the list.');
      return;
    }
    if (classification === 'Others' && !classificationOther.trim()) {
      setErrorMsg('Please specify your Classification, or choose one from the list.');
      return;
    }
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        setErrorMsg('Camera access is required to complete face registration.');
        return;
      }
    }
    setStep('capture');
  };

  // Animates the current challenge's "scanning" ring while we're actively
  // polling for it, and stops cleanly the moment the step resolves.
  useEffect(() => {
    if (stepStatus !== 'scanning' && stepStatus !== 'blink') return undefined;
    scanPulse.setValue(0);
    const loop = Animated.loop(
      Animated.timing(scanPulse, { toValue: 1, duration: 1100, easing: Easing.out(Easing.ease), useNativeDriver: true })
    );
    loop.start();
    return () => loop.stop();
  }, [stepStatus, scanPulse]);

  // Pops the confirmed (check) / failed (x) icon in with a little spring bounce.
  useEffect(() => {
    if (stepStatus === 'confirmed' || stepStatus === 'failed') {
      resultPop.setValue(0);
      Animated.spring(resultPop, { toValue: 1, useNativeDriver: true, friction: 4, tension: 90 }).start();
    }
  }, [stepStatus, resultPop]);

  // Auto-start the scan when the camera is ready.
  const handleCameraReady = () => {
    if (!mountedRef.current) return;
    setCameraReady(true);
    handleStartGuidedCapture();
  };

  const handleLiveStatus = (status) => {
    if (!verifyingRef.current) return;
    setLive(status);
    setStepStatus(status.phase === 'blink' ? 'blink' : 'scanning');
  };

  // Hold-then-blink check with retries; returns the selfie and video.
  const handleStartGuidedCapture = async () => {
    setErrorMsg('');
    if (!cameraRef.current || verifyingRef.current) return;

    setCaptureStage('recording');
    setLive({ phase: 'hold', faceDetected: false, hint: null, eyesClosed: false });
    verifyingRef.current = true;

    let result = { ok: false, reason: 'no-face' };
    for (let attempt = 0; attempt < DETECTION_ATTEMPTS && !result.ok; attempt++) {
      if (!verifyingRef.current || !cameraRef.current) return;
      setStepStatus('scanning');
      result = await cameraRef.current.runLiveness();
      if (result.reason === 'cancelled' || !verifyingRef.current) {
        discardCapture(result);
        return;
      }
      if (!result.ok && attempt < DETECTION_ATTEMPTS - 1) {
        setStepStatus('failed');
        await wait(300); // let the "didn't catch that" feedback register before retrying
      }
    }

    verifyingRef.current = false;
    if (!result.ok) {
      setStepStatus('failed');
      await wait(400);
      setErrorMsg(livenessFailureMessage(result.reason));
      setStepStatus('idle');
      setCaptureStage('ready');
      return;
    }

    if (!mountedRef.current) {
      discardCapture(result);
      return;
    }
    setCapturedPhoto({ uri: result.photoUri, video: result.video });
    result.video.then((videoUri) => {
      // Shown in the review badge once the clip has finished writing.
      if (mountedRef.current) setCapturedVideoUri(videoUri);
    });
    setCaptureStage('reviewing');
    setStepStatus('idle');
  };

  const handleCancelRecording = () => {
    verifyingRef.current = false;
    cameraRef.current?.cancel();
    setStepStatus('idle');
    setCaptureStage('ready');
  };

  const handleRetake = () => {
    if (capturedPhoto) discardCapture({ photoUri: capturedPhoto.uri, video: capturedPhoto.video });
    setCapturedVideoUri(null);
    setCapturedPhoto(null);
    setCameraReady(false); // the camera remounts; Start waits for it again
    setStepStatus('idle');
    setErrorMsg('');
    setLockInfo(null);
    setCaptureStage('ready');
  };

  // Stop any in-progress detection if the employee navigates away mid-sequence.
  useEffect(() => () => {
    verifyingRef.current = false;
    cameraRef.current?.cancel();
  }, []);

  const handleSubmit = async () => {
    if (!capturedPhoto) return;
    setErrorMsg('');
    setLockInfo(null);
    setSubmitting(true);
    try {
      const device = getDeviceInfo();
      const formData = new FormData();
      formData.append('employee_code', employeeCode.trim().toUpperCase());
      formData.append('surname', surname.trim());
      formData.append('given_name', givenName.trim());
      if (middleName.trim()) formData.append('middle_name', middleName.trim());
      if (suffix !== 'None') formData.append('suffix', suffix);
      if (department) formData.append('department', department);
      // Send the typed value instead of "Others".
      const positionValue = position === 'Others' ? positionOther.trim() : position;
      if (positionValue) formData.append('position', positionValue);
      const genderValue = gender === 'Others' ? genderOther.trim() : gender;
      if (genderValue) formData.append('gender', genderValue);
      const classificationValue = classification === 'Others' ? classificationOther.trim() : classification;
      formData.append('classification', classificationValue);
      formData.append('device_uid', device.uid);
      formData.append('device_model', device.model);
      formData.append('device_brand', device.brand);
      formData.append('device_os', device.os);
      formData.append('liveness_verified', 'true');
      formData.append('liveness_actions', 'hold,blink');
      formData.append('image', {
        uri: capturedPhoto.uri,
        name: 'face.jpg',
        type: 'image/jpeg',
      });
      const videoUri = await capturedPhoto.video;
      if (videoUri) {
        formData.append('video', { uri: videoUri, name: 'face.mp4', type: 'video/mp4' });
      }
      registeredRef.current = true;
      await completeRegistration(formData);
      // RootNavigator moves to WaitingApproval on its own.
    } catch (err) {
      registeredRef.current = false;
      if (!mountedRef.current) return;
      // 423: DoubleSafe lockout, shown in its own panel.
      if (err.response?.status === 423) {
        setLockInfo({ message: err.response?.data?.message || 'Too many failed identity checks. Please try again later or contact your administrator.' });
      } else {
        setErrorMsg(err.response?.data?.message || 'Registration failed. Please check your details and try again.');
      }
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleCancel = () => {
    cancelRegistration();
    navigation.replace('Login');
  };

  if (step === 'capture') {
    const ringScale = scanPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] });
    const ringOpacity = scanPulse.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.45, 0.12, 0] });
    const popScale = resultPop.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.4, 1.15, 1] });

    let challengeCaption = '';
    if (stepStatus === 'scanning' || stepStatus === 'blink') challengeCaption = livenessCaption(live);
    else if (stepStatus === 'confirmed') challengeCaption = 'Confirmed!';
    else if (stepStatus === 'failed') challengeCaption = "Didn't catch that \u2014 let's try again";
    else if (stepStatus === 'finishing') challengeCaption = 'Hold still \u2014 capturing\u2026';

    // Ring: neutral while scanning, green on success, red on failure.
    let ringVariant = styles.guideFrameSearching;
    if (captureStage === 'recording') {
      if (stepStatus === 'confirmed' || stepStatus === 'finishing') ringVariant = styles.guideFrameFound;
      else if (stepStatus === 'failed') ringVariant = styles.guideFrameFailed;
    }

    // Landscape: controls move to a side panel.
    const sidePanel = isLandscape;
    const SheetContainer = sidePanel ? ScrollView : View;
    const sheetProps = sidePanel
      ? {
          style: [styles.sideSheet, { width: isCompactHeight ? 340 : 400 }],
          contentContainerStyle: [styles.sideSheetContent, { paddingRight: 24 + insets.right, paddingBottom: 20 + insets.bottom }],
        }
      : {
          style: [
            styles.bottomSheet,
            { paddingHorizontal: Math.max(24, (width - MAX_WIDTH.form) / 2), paddingBottom: Math.max(28, insets.bottom + 12) },
          ],
        };
    const guideScale = isCompactHeight ? Math.min(1, (height - 110) / 312) : 1;
    const overlayInsets = { left: insets.left };

    return (
      <View style={[styles.cameraContainer, sidePanel && styles.cameraContainerRow]}>
        {captureStage === 'reviewing' ? (
          <>
            <View style={styles.previewWrap}>
              <Image source={{ uri: capturedPhoto.uri }} style={styles.preview} />
              <View style={styles.topScrim} pointerEvents="none" />
              <View style={[styles.videoBadge, isCompactHeight && { top: 16 }, { left: 20 + insets.left }]}>
                <View style={styles.videoBadgeIconWrap}>
                  <Ionicons name="checkmark-circle" size={22} color={colors.success} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.videoBadgeTitle}>Liveness verified in real time</Text>
                  <Text style={styles.videoBadgeSubtitle}>
                    {capturedVideoUri ? 'Video selfie recorded · live blink detected' : 'Live face and blink detected on-device'}
                  </Text>
                </View>
              </View>
            </View>
            <SheetContainer {...sheetProps}>
              {!sidePanel && <View style={styles.sheetHandle} />}
              {lockInfo ? (
                <>
                  <View style={styles.lockPanel}>
                    <Ionicons name="lock-closed" size={26} color={colors.dangerText} style={{ marginBottom: 8 }} />
                    <Text style={styles.lockPanelTitle}>Identity Verification Locked</Text>
                    <Text style={styles.lockPanelText}>{lockInfo.message}</Text>
                  </View>
                  <TouchableOpacity style={styles.retakeBtn} onPress={handleCancel} disabled={submitting}>
                    <Text style={styles.retakeBtnText}>Back to Sign In</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
                  <PrimaryButton title="Complete Registration" onPress={handleSubmit} loading={submitting} style={{ width: '100%' }} />
                  <TouchableOpacity style={styles.retakeBtn} onPress={handleRetake} disabled={submitting}>
                    <Text style={styles.retakeBtnText}>Retake Photo</Text>
                  </TouchableOpacity>
                </>
              )}
            </SheetContainer>
          </>
        ) : (
          <>
            {/* The camera doesn't support children, so the overlays sit beside it in this wrapper, which takes the old camera style. */}
            <View style={styles.camera}>
              <LiveFaceCamera
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                onReady={handleCameraReady}
                onStatus={handleLiveStatus}
              />
              <View style={[styles.topScrim, { height: (isCompactHeight ? 90 : 130) + insets.top }]} pointerEvents="none" />
              <View style={[styles.topBar, { top: (isCompactHeight ? 8 : 14) + insets.top, paddingLeft: 20 + insets.left }]} pointerEvents="none">
                <StepProgress current={1} labels={['Details', 'Face Scan']} dark />
              </View>

              <View style={[styles.guideFrameWrap, guideScale < 1 && { transform: [{ scale: guideScale }] }]}>
                <View style={[styles.guideFrame, ringVariant]} />
                {stepStatus === 'confirmed' && <View style={styles.guideFrameGlow} pointerEvents="none" />}
              </View>

              {captureStage === 'ready' ? (
                <View style={[styles.readyCaptionWrap, isCompactHeight && { bottom: 12 }, overlayInsets]} pointerEvents="none">
                  <Text style={styles.guideText}>Center your face within the frame</Text>
                </View>
              ) : (
                <View style={[styles.challengeOverlay, isCompactHeight && styles.challengeOverlayCompact, overlayInsets, { top: insets.top }]} pointerEvents="none">
                  <View style={styles.challengeTopGroup}>
                    {stepStatus === 'finishing' ? (
                      <View style={styles.recBadge}>
                        <View style={styles.recDot} />
                        <Text style={styles.recBadgeText}>CAPTURING</Text>
                      </View>
                    ) : (
                      <View style={[styles.recBadge, styles.scanBadge]}>
                        <View style={[styles.recDot, liveFaceDetected ? styles.scanDotFound : styles.scanDotSearching]} />
                        <Text style={styles.recBadgeText}>{liveFaceDetected ? 'FACE FOUND' : 'SEARCHING\u2026'}</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.challengeBottomGroup}>
                    <View style={styles.challengeIconWrap}>
                      {(stepStatus === 'scanning' || stepStatus === 'blink') && (
                        <>
                          {/* Translucent "detecting" backdrop -- the loading indicator itself is meant to read as see-through, not a solid disc. */}
                          <View style={styles.scanBackdrop} />
                          <Animated.View style={[styles.scanRing, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
                        </>
                      )}
                      {stepStatus === 'confirmed' || stepStatus === 'failed' ? (
                        <Animated.View style={{ transform: [{ scale: popScale }] }}>
                          <Ionicons
                            name={stepStatus === 'confirmed' ? 'checkmark-circle' : 'close-circle'}
                            size={44}
                            color={stepStatus === 'confirmed' ? colors.success : colors.error}
                          />
                        </Animated.View>
                      ) : (
                        <Ionicons
                          name={
                            stepStatus === 'finishing' ? 'checkmark-circle'
                              : stepStatus === 'blink' ? (live.eyesClosed ? 'eye-off-outline' : 'eye-outline')
                              : 'scan-outline'
                          }
                          size={40}
                          color="#fff"
                        />
                      )}
                    </View>
                    <Text style={styles.challengeText}>{challengeCaption}</Text>
                  </View>
                </View>
              )}
            </View>
            <SheetContainer {...sheetProps}>
              {!sidePanel && <View style={styles.sheetHandle} />}
              {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
              {captureStage === 'ready' ? (
                <>
                  <View style={styles.secureBadgeRow}>
                    <Ionicons name="shield-checkmark-outline" size={14} color={colors.textSub} />
                    <Text style={styles.secureBadgeText}>Secure Identity Verification</Text>
                  </View>
                  <Text style={styles.captureHint}>
                    Hold your face steady in the frame, then blink once when prompted \u2014 we detect it live from the video and capture automatically. If this is a new device for an already-registered account, your face is also matched against your identity on file, just like GCash's DoubleSafe.
                  </Text>
                  <PrimaryButton
                    title={cameraReady ? 'Start Face Scan' : 'Starting camera\u2026'}
                    onPress={handleStartGuidedCapture}
                    disabled={!cameraReady}
                    style={{ width: '100%' }}
                  />
                  <TouchableOpacity onPress={() => setStep('details')}>
                    <Text style={styles.backLink}>{'\u2190'} Back to details</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity onPress={handleCancelRecording} style={{ paddingVertical: 6 }}>
                  <Text style={styles.backLink}>Cancel</Text>
                </TouchableOpacity>
              )}
            </SheetContainer>
          </>
        )}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[contentStyle(MAX_WIDTH.form), { paddingTop: Math.max(40, topPad), paddingBottom: 20 + insets.bottom }]}
    >
      <FadeIn>
        <StepProgress current={0} labels={['Details', 'Face Scan']} />
        <Text style={styles.header}>{pendingGoogle?.existingEmployee ? 'Verify This Device' : 'Device Registration'}</Text>
        <Text style={styles.subtext}>
          Signed in as {pendingGoogle?.google?.given_name || ''} {pendingGoogle?.google?.family_name || ''} ({pendingGoogle?.google?.email}).{' '}
          {pendingGoogle?.existingEmployee
            ? "This device isn't recognized yet, so we need to confirm it's really you. Your details are pre-filled — check them, then you'll be asked to verify your face to finish."
            : "Confirm your official employee details, then you'll be asked to register your face to finish."}
        </Text>
      </FadeIn>

      <FadeIn delay={80}>
        <View style={styles.card}>
        <Text style={styles.inputLabel}>Employee ID *</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. E001"
          placeholderTextColor="#94A3B8"
          autoCapitalize="characters"
          value={employeeCode}
          onChangeText={setEmployeeCode}
        />

        <Text style={styles.inputLabel}>Surname *</Text>
        <TextInput
          style={styles.input}
          placeholder="Dela Cruz"
          placeholderTextColor="#94A3B8"
          value={surname}
          onChangeText={setSurname}
        />

        <Text style={styles.inputLabel}>Given Name *</Text>
        <TextInput
          style={styles.input}
          placeholder="Juan"
          placeholderTextColor="#94A3B8"
          value={givenName}
          onChangeText={setGivenName}
        />

        <Text style={styles.inputLabel}>Middle Name</Text>
        <TextInput
          style={styles.input}
          placeholder="Optional"
          placeholderTextColor="#94A3B8"
          value={middleName}
          onChangeText={setMiddleName}
        />

        <Text style={styles.inputLabel}>Suffix Name</Text>
        <TouchableOpacity style={styles.dropdownInput} onPress={() => setSuffixPickerOpen(true)}>
          <Text style={suffix === 'None' ? styles.dropdownPlaceholder : styles.dropdownValue}>{suffix}</Text>
          <Text style={styles.dropdownCaret}>{'\u25BE'}</Text>
        </TouchableOpacity>

        <Text style={styles.inputLabel}>Department *</Text>
        <TouchableOpacity style={styles.dropdownInput} onPress={() => setDepartmentPickerOpen(true)}>
          <Text style={department ? styles.dropdownValue : styles.dropdownPlaceholder}>{department || 'Select department'}</Text>
          <Text style={styles.dropdownCaret}>{'\u25BE'}</Text>
        </TouchableOpacity>

        <DropdownFieldWithOthers
          label="Position"
          required
          options={positionOptions}
          value={position}
          onSelect={setPosition}
          otherValue={positionOther}
          onOtherChange={setPositionOther}
          pickerOpen={positionPickerOpen}
          setPickerOpen={setPositionPickerOpen}
          placeholder="Select position"
          otherPlaceholder="Enter your position"
        />

        <DropdownFieldWithOthers
          label="Gender"
          required
          options={GENDER_OPTIONS}
          value={gender}
          onSelect={setGender}
          otherValue={genderOther}
          onOtherChange={setGenderOther}
          pickerOpen={genderPickerOpen}
          setPickerOpen={setGenderPickerOpen}
          placeholder="Select gender"
          otherPlaceholder="Enter your gender"
        />

        <DropdownFieldWithOthers
          label="Classification"
          required
          options={classificationOptions}
          value={classification}
          onSelect={setClassification}
          otherValue={classificationOther}
          onOtherChange={setClassificationOther}
          pickerOpen={classificationPickerOpen}
          setPickerOpen={setClassificationPickerOpen}
          placeholder="Select classification"
          otherPlaceholder="Enter classification"
        />
        </View>

        <View style={styles.deviceCard}>
          <Text style={styles.deviceText}>{deviceInfo}</Text>
        </View>

        {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}

        <PrimaryButton title="Continue to Face Registration" onPress={handleContinueToCapture} disabled={submitting} style={{ marginTop: 15 }} />
        <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel} disabled={submitting}>
          <Text style={styles.cancelBtnText}>Cancel</Text>
        </TouchableOpacity>
      </FadeIn>

      {/* Simple modal-based dropdown for Suffix Name -- avoids pulling in a native
          picker dependency that would require a new dev-client build. */}
      <Modal visible={suffixPickerOpen} transparent animationType="fade" supportedOrientations={MODAL_ORIENTATIONS} onRequestClose={() => setSuffixPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setSuffixPickerOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Suffix Name</Text>
            <FlatList
              data={SUFFIX_OPTIONS}
              keyExtractor={(item) => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalOption}
                  onPress={() => {
                    setSuffix(item);
                    setSuffixPickerOpen(false);
                  }}
                >
                  <Text style={[styles.modalOptionText, item === suffix && styles.modalOptionTextActive]}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Department picker -- options come from GET /api/employee-auth/departments. */}
      <Modal visible={departmentPickerOpen} transparent animationType="fade" supportedOrientations={MODAL_ORIENTATIONS} onRequestClose={() => setDepartmentPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setDepartmentPickerOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>Department</Text>
            {departments.length === 0 ? (
              <Text style={styles.modalEmptyText}>No departments available yet.</Text>
            ) : (
              <FlatList
                data={departments}
                keyExtractor={(item) => String(item.id)}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.modalOption}
                    onPress={() => {
                      setDepartment(item.name);
                      setDepartmentPickerOpen(false);
                    }}
                  >
                    <Text style={[styles.modalOptionText, item.name === department && styles.modalOptionTextActive]}>{item.name}</Text>
                  </TouchableOpacity>
                )}
              />
            )}
          </View>
        </TouchableOpacity>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { fontSize: 20, fontWeight: '800', color: colors.cspcBlue },
  subtext: { color: colors.textSub, fontSize: 13, marginTop: 6, marginBottom: 18, lineHeight: 18 },
  // Top-of-wizard step indicator (Details -> Face Scan), reused on both screens.
  stepProgressRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', marginBottom: 18 },
  stepProgressItem: { alignItems: 'center', width: 84 },
  stepDot: {
    width: 26, height: 26, borderRadius: 13, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent',
  },
  stepDotActive: { backgroundColor: colors.success },
  stepDotNum: { fontSize: 12, fontWeight: '800' },
  stepDotCheck: { color: '#fff', fontSize: 13, fontWeight: '800' },
  stepLabel: { fontSize: 10, fontWeight: '700', marginTop: 6, textTransform: 'uppercase', letterSpacing: 0.4 },
  stepConnector: { flex: 1, height: 2, marginTop: 12, maxWidth: 36 },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 18,
    borderWidth: 1, borderColor: colors.border, ...shadow, marginBottom: 15,
  },
  inputLabel: { fontSize: 10, fontWeight: '800', color: colors.cspcBlue, textTransform: 'uppercase', marginBottom: 6, marginTop: 10 },
  input: { borderWidth: 2, borderColor: colors.border, borderRadius: radius.sm, padding: 12, fontSize: 14, color: colors.textMain },
  dropdownInput: {
    borderWidth: 2, borderColor: colors.border, borderRadius: radius.sm, padding: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  dropdownPlaceholder: { fontSize: 14, color: '#94A3B8' },
  dropdownValue: { fontSize: 14, color: colors.textMain },
  dropdownCaret: { fontSize: 14, color: colors.textSub },
  deviceCard: { backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: 16, marginBottom: 8 },
  deviceText: { fontFamily: 'monospace', fontSize: 12, lineHeight: 18, color: colors.textMain },
  errorText: { color: colors.error, fontSize: 12, marginVertical: 8, textAlign: 'center' },
  cancelBtn: { padding: 14, alignItems: 'center', marginTop: 4, marginBottom: 20 },
  cancelBtnText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  modalSheet: { width: '100%', maxWidth: 560, alignSelf: 'center', backgroundColor: colors.white, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingTop: 12, paddingBottom: 24, maxHeight: '55%' },
  modalTitle: { fontSize: 13, fontWeight: '800', color: colors.cspcBlue, textTransform: 'uppercase', textAlign: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalOption: { paddingVertical: 16, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  modalOptionText: { fontSize: 15, color: colors.textMain, textAlign: 'center' },
  modalOptionTextActive: { color: colors.cspcBlue, fontWeight: '800' },
  modalEmptyText: { color: colors.textSub, fontSize: 13, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 24 },

  // Step 2: guided, real-time-verified face capture
  cameraContainer: { flex: 1, backgroundColor: '#0B0F1A' },
  cameraContainerRow: { flexDirection: 'row' },
  camera: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewWrap: { flex: 1 },
  preview: { flex: 1, resizeMode: 'cover' },
  topScrim: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 130,
    backgroundColor: 'rgba(11,15,26,0.55)',
  },
  topBar: { position: 'absolute', top: 14, left: 0, right: 0, paddingHorizontal: 20 },
  guideFrameWrap: { alignItems: 'center', justifyContent: 'center' },
  guideFrame: {
    width: 226, height: 296, borderRadius: 148, borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.55)', alignSelf: 'center',
  },
  guideFrameFound: { borderColor: colors.success },
  guideFrameSearching: { borderColor: '#FFB547' },
  guideFrameFailed: { borderColor: colors.error },
  // Soft glow ring just outside the frame when the correct action is
  // confirmed -- a gentle "halo" rather than a hard second border.
  guideFrameGlow: {
    position: 'absolute', width: 242, height: 312, borderRadius: 156,
    borderWidth: 8, borderColor: colors.success, opacity: 0.18,
  },
  readyCaptionWrap: { position: 'absolute', bottom: 130, left: 0, right: 0 },
  guideText: {
    textAlign: 'center', color: '#fff', fontSize: 14, fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 8,
  },
  // Capture overlay: status at the top, instruction at the bottom.
  challengeOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'space-between', paddingVertical: 56, paddingHorizontal: 24,
  },
  challengeOverlayCompact: { paddingVertical: 14 },
  challengeTopGroup: { alignItems: 'center' },
  challengeBottomGroup: { alignItems: 'center', width: '100%' },
  recBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: 'rgba(238,93,80,0.85)', paddingVertical: 6, paddingHorizontal: 12,
    borderRadius: 20, marginBottom: 14,
  },
  scanBadge: { backgroundColor: 'rgba(15,23,42,0.65)' },
  recDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
  // Face visible is not success, so never green.
  scanDotFound: { backgroundColor: colors.info },
  scanDotSearching: { backgroundColor: '#FFB547' },
  recBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  dotsRow: { flexDirection: 'row', gap: 8 },
  challengeDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.35)' },
  challengeDotActive: { backgroundColor: '#fff', width: 11, height: 11, borderRadius: 6 },
  challengeDotDone: { backgroundColor: colors.success },
  challengeDotFailed: { backgroundColor: colors.error, width: 11, height: 11, borderRadius: 6 },
  // Icon + its looping "scanning" indicator sit in a fixed-size box so
  // nothing nudges surrounding layout as it expands/fades.
  challengeIconWrap: { width: 72, height: 72, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  scanBackdrop: {
    position: 'absolute', width: 68, height: 68, borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  scanRing: {
    position: 'absolute', width: 64, height: 64, borderRadius: 32,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)',
  },
  challengeText: {
    color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.4)', textShadowRadius: 6,
  },
  bottomSheet: {
    backgroundColor: colors.white, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    paddingTop: 10, paddingBottom: 28, paddingHorizontal: 24, alignItems: 'center', ...shadow,
  },
  // Landscape: the same sheet as a full-height panel on the right.
  sideSheet: {
    backgroundColor: colors.white, borderTopLeftRadius: radius.xl, borderBottomLeftRadius: radius.xl, ...shadow,
  },
  sideSheetContent: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 20, paddingLeft: 24 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 16 },
  secureBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  secureBadgeText: { color: colors.textSub, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
  captureHint: { color: colors.textSub, fontSize: 12, textAlign: 'center', lineHeight: 17, marginBottom: 16 },
  backLink: { color: colors.textSub, fontSize: 13, fontWeight: '600', marginTop: 14 },
  retakeBtn: { padding: 12, alignItems: 'center', marginTop: 6 },
  retakeBtnText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
  // Reviewing stage: badge overlaid on the captured still confirming the
  // hold + blink liveness check passed before this photo was taken.
  videoBadge: {
    position: 'absolute', top: 50, left: 20, right: 20,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: 'rgba(15,23,42,0.72)', borderRadius: radius.md, padding: 14,
  },
  videoBadgeIconWrap: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  videoBadgeTitle: { color: '#fff', fontWeight: '800', fontSize: 13 },
  videoBadgeSubtitle: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginTop: 3 },
  // DoubleSafe lockout panel (423).
  lockPanel: {
    backgroundColor: colors.dangerBg, borderWidth: 1, borderColor: 'rgba(238,93,80,0.35)',
    borderRadius: radius.md, padding: 18, alignItems: 'center', marginBottom: 16, width: '100%',
  },
  lockPanelTitle: { color: colors.dangerText, fontWeight: '800', fontSize: 14, marginBottom: 6 },
  lockPanelText: { color: colors.textMain, fontSize: 12, textAlign: 'center', lineHeight: 17 },
});
