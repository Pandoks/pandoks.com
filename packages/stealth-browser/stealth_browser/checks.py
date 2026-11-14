"""Detection probes -- the same checks a real fingerprinter runs.

`PROBE_JS` is injected into a page and returns a dict of raw signals. `score()`
turns that into a pass/fail report. We deliberately re-implement the *cheap,
decisive* checks (webdriver flag, headless UA, CDP Runtime.enable leak, UA vs
platform coherence) so we get a fast verdict without depending on a remote
service -- then `creepjs.py` cross-checks against the real CreepJS page.

Sections 15-35 add the extended adversarial surfaces (WebGPU, Intl/ICU,
font coherence, timing precision, audio signature, codecs, permissions,
device APIs, storage, runtime artifacts, EME/WebCodecs/WebAuthn, and the
GPU/video pipelines) ported from the external round-1/round-2 probe suites,
so every battery run covers them. Sections 36-45 add the CDP/automation-leak
and network-stack surfaces plus the 2026-11 detection-gap extension (CSS
media queries + system colors, Intl timezone depth, WebRTC capability depth,
sensors/misc presence, WebAuthn capability matrix, Wasm feature matrix).
"""

from __future__ import annotations

# Runs in the page. Pure JS, no automation API. Returns a JSON-able object.
PROBE_JS = r"""
async () => {
  const r = {};

  // --- 1. the classic automation flag ---
  r.webdriver = navigator.webdriver;                       // want: false

  // --- 2. headless markers in the UA ---
  const ua = navigator.userAgent;
  r.userAgent = ua;
  r.uaHasHeadless = /HeadlessChrome/i.test(ua);            // want: false

  // --- 3. UA <-> platform coherence (a top CreepJS "lie") ---
  r.platform = navigator.platform;
  const uaMac = /Macintosh|Mac OS X/.test(ua);
  const uaWin = /Windows/.test(ua);
  r.uaPlatformCoherent =
    (uaMac && navigator.platform === 'MacIntel') ||
    (uaWin && navigator.platform === 'Win32') ||
    (!uaMac && !uaWin);                                    // want: true

  // --- 4. real window chrome runtime object exists in real Chrome ---
  r.hasChromeObject = typeof window.chrome === 'object' && window.chrome !== null;
  r.hasChromeRuntime = !!(window.chrome && window.chrome.runtime !== undefined);

  // --- 5. permissions API must NOT contradict Notification state ---
  // headless Chrome historically returned 'denied' while Notification said
  // 'default' -- a famous tell.
  r.notificationPermission = (typeof Notification !== 'undefined')
    ? Notification.permission : 'no-Notification-API';

  // --- 6. plugins / mimeTypes: real desktop Chrome has the PDF plugin ---
  r.pluginsLength = navigator.plugins.length;              // want: > 0
  r.mimeTypesLength = navigator.mimeTypes.length;

  // --- 7. languages must be a non-empty array consistent with locale ---
  r.languages = navigator.languages;
  r.languagesOk = Array.isArray(navigator.languages)
    && navigator.languages.length > 0;

  // --- 8. WebGL must exist and report a real-ish GPU (not SwiftShader) ---
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      r.webglVendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null;
      r.webglRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
      // WebGL must WORK and not report Chrome's internal "SwiftShader" (a
      // headless tell). 'llvmpipe' is Mesa's software renderer -- genuine on
      // the many real GPU-less Linux desktops/VMs, and CreepJS does not flag
      // it -- so it is accepted. A null/missing renderer is not.
      r.webglOk = !!r.webglRenderer
        && !/swiftshader/i.test(r.webglRenderer || '');
    } else {
      r.webglOk = false;
    }
  } catch (e) { r.webglOk = false; r.webglError = String(e); }

  // --- 9. canvas actually renders (toDataURL non-empty / non-blank) ---
  try {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 50;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = '#069';
    ctx.fillText('stealth-check \u{1F60A}', 2, 2);
    const data = c.toDataURL();
    r.canvasOk = data.length > 1000;                       // want: true
  } catch (e) { r.canvasOk = false; r.canvasError = String(e); }

  // --- 10. CDP Runtime.enable leak (the decisive 2026 signal) ---
  // When an automation client enables the CDP 'Runtime' domain, logging an
  // Error serializes it across the CDP socket, which triggers a getter on
  // .stack. If the getter fires, CDP is observable from page JS.
  let cdpLeak = false;
  try {
    const e = new Error();
    Object.defineProperty(e, 'stack', {
      configurable: true,
      get() { cdpLeak = true; return ''; },
    });
    // eslint-disable-next-line no-console
    console.debug(e);
  } catch (_) { /* ignore */ }
  r.cdpRuntimeLeak = cdpLeak;                              // want: false

  // --- 11. hardwareConcurrency / deviceMemory present & plausible ---
  r.hardwareConcurrency = navigator.hardwareConcurrency;
  r.deviceMemory = navigator.deviceMemory;
  r.hardwareOk = navigator.hardwareConcurrency >= 2;

  // --- 12. outerWidth/innerWidth: headless often has outer == 0 ---
  r.outerWidth = window.outerWidth;
  r.innerWidth = window.innerWidth;
  r.windowDimsOk = window.outerWidth > 0 && window.outerHeight > 0;

  // --- 13. driver-layer leaks (patchright leak map) ---
  r.pwGlobals = Object.getOwnPropertyNames(globalThis)
    .filter(k => /^__(pw|playwright)/i.test(k)).length;     // want: 0
  r.nextHopProtocol = (performance.getEntriesByType('navigation')[0] || {}).nextHopProtocol || '';
  r.nextHopOk = r.nextHopProtocol !== '';                   // want: true (no doc re-serving)
  try {
    const e = new Error();
    r.stackClean = !/pptr:|eval at <anonymous>|__puppeteer_evaluation_script__/i
      .test(e.stack || '');
  } catch (_) { r.stackClean = false; }                     // want: true
  r.userActivationPresent = !!navigator.userActivation;     // informational

  // --- 14. WebRTC ICE must not reveal an IP the HTTP path does not ---
  // Chrome's proxies carry TCP only: under the default IP-handling policy
  // STUN goes out over UDP directly and the srflx candidate carries the
  // host's real egress IP next to proxied HTTP (detector-sources.md A8).
  // Invariant: every public IP in a candidate is an HTTP egress IP. Unproxied
  // that is srflx == egress; proxied (disable_non_proxied_udp) it is zero
  // candidates. mDNS .local hosts and private ranges are not IPs a page can
  // use and are ignored.
  r.webrtcCandidates = [];
  try {
    const pc = new RTCPeerConnection({
      iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
    pc.createDataChannel('probe');
    const gathered = new Promise(res => {
      pc.onicecandidate = e => {
        if (e.candidate) r.webrtcCandidates.push(e.candidate.candidate);
        else res();
      };
      setTimeout(res, 5000);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await gathered;
    pc.close();
  } catch (e) { r.webrtcError = String(e); }
  const isPrivate = ip => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:|::1$)/i.test(ip);
  r.webrtcPublicIps = [...new Set(r.webrtcCandidates
    .map(c => c.split(' ')[4])
    .filter(a => a && !/\.local$/i.test(a) && !isPrivate(a)))];
  r.httpEgressIps = [];
  for (const u of ['https://api.ipify.org/?format=json',
                   'https://api64.ipify.org/?format=json']) {
    try {
      const j = await (await fetch(u)).json();
      if (j.ip && !r.httpEgressIps.includes(j.ip)) r.httpEgressIps.push(j.ip);
    } catch (_) { /* unknown egress: any public candidate IP then fails */ }
  }

  // --- 15. webdriver must still be a plain boolean (string-masked = tell) ---
  r.webdriverType = typeof navigator.webdriver;

  // --- 16. WebGPU: stock desktop Chrome exposes it; adapter info is GPU truth ---
  try {
    r.gpuPresent = 'gpu' in navigator;
    r.gpuRequestAdapter = !!(navigator.gpu && navigator.gpu.requestAdapter);
    if (r.gpuPresent && r.gpuRequestAdapter) {
      const gpuAdapter = await navigator.gpu.requestAdapter();
      if (gpuAdapter) {
        const gpuInfo = gpuAdapter.info ? await gpuAdapter.info
          : (gpuAdapter.requestAdapterInfo ? await gpuAdapter.requestAdapterInfo() : null);
        r.gpuAdapterInfo = gpuInfo ? Object.fromEntries(Object.entries(gpuInfo)) : null;
      } else {
        r.gpuAdapterInfo = null;
      }
    }
  } catch (e) { r.gpuAdapterError = String(e); }
  r.webgpuOk = r.gpuPresent === true && r.gpuRequestAdapter === true
    && !r.gpuAdapterError
    && !Object.values(r.gpuAdapterInfo || {}).some(v => /swiftshader/i.test(String(v)));

  // --- 17. Intl/ICU: locale-table truth a stock V8/ICU4X build must satisfy ---
  try { r.intlSvOz = new Intl.Collator('sv').compare('ö', 'z'); }
  catch (e) { r.intlCollationError = String(e); }
  try { r.intlEnOz = new Intl.Collator('en').compare('ö', 'z'); }
  catch (e) { r.intlCollationError = String(e); }
  r.intlCollationOk = typeof r.intlSvOz === 'number' && r.intlSvOz > 0
    && r.intlEnOz < 0 && r.intlSvOz !== r.intlEnOz;
  try {
    r.intlArEgNumber = new Intl.NumberFormat('ar-EG').format(1234);
    r.intlEnNumber = new Intl.NumberFormat('en').format(1234);
  } catch (e) { r.intlNumberingError = String(e); }
  r.intlNumberingOk = !!r.intlArEgNumber && r.intlArEgNumber !== r.intlEnNumber;
  try {
    r.intlPluralCy = [0, 1, 2, 3, 4, 6, 11].map(n => new Intl.PluralRules('cy').select(n));
  } catch (e) { r.intlPluralError = String(e); }
  r.intlPluralCyOk = Array.isArray(r.intlPluralCy) && r.intlPluralCy[0] === 'zero'
    && r.intlPluralCy[1] === 'one' && r.intlPluralCy[2] === 'two'
    && r.intlPluralCy[3] === 'few' && r.intlPluralCy[6] === 'other';
  try {
    r.intlTimeZones = Intl.supportedValuesOf('timeZone').length;
    r.intlCurrencies = Intl.supportedValuesOf('currency').length;
    r.intlCalendars = Intl.supportedValuesOf('calendar').length;
  } catch (e) { r.intlSupportedError = String(e); }
  r.intlSupportedValuesOk = r.intlTimeZones > 100 && r.intlCurrencies > 100;
  // bare `new Intl.DisplayNames('en')` THROWS on stock V8/ICU4X -- the typed
  // constructors are the API; assert those, not bare construction.
  try {
    r.intlDisplayRegion = new Intl.DisplayNames('en', {type: 'region'}).of('US');
    r.intlDisplayLanguage = new Intl.DisplayNames('en', {type: 'language'}).of('us');
    try { new Intl.DisplayNames('en'); }
    catch (e) { r.intlDisplayBareError = String(e).slice(0, 60); }
    r.intlDisplayNamesOk = typeof Intl.DisplayNames === 'function'
      && typeof Intl.RelativeTimeFormat === 'function'
      && r.intlDisplayRegion === 'United States' && r.intlDisplayLanguage === 'us';
  } catch (e) { r.intlDisplayError = String(e); r.intlDisplayNamesOk = false; }

  // --- 18. font-set coherence (a Windows persona needs Windows-core fonts) ---
  // The catalog lists must stay in lockstep with the persona-OS font layer:
  // the Windows list is the same set the stealth image installs and
  // name-clones (packages/stealth-chromium/Dockerfile +
  // scripts/remap_persona_fonts.py) and the same set the Windows allowlist in
  // packages/stealth-chromium/chromium_src/third_party/blink/renderer/platform/
  // fonts/apex_font_policy.h allows. Ground truth for the Windows list is
  // Microsoft's Win10/11 font lists (see
  // /var/tmp/research/environment-coherence.md section 2.1).
  try {
    const fontCatalog = {
      windows: ['Segoe UI', 'Segoe UI Bold', 'Segoe UI Light',
        'Segoe UI Semibold', 'Segoe UI Semilight', 'Arial', 'Arial Black',
        'Calibri', 'Calibri Bold', 'Cambria', 'Cambria Bold', 'Cambria Math',
        'Candara', 'Candara Bold', 'Comic Sans MS', 'Consolas', 'Consolas Bold',
        'Constantia', 'Constantia Bold', 'Corbel', 'Corbel Bold', 'Courier New',
        'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia',
        'Hololens MDL2 Assets', 'Impact', 'Ink Free', 'Javanese Text',
        'Leelawadee UI', 'Lucida Console', 'Lucida Console Bold',
        'Malgun Gothic', 'Marlett', 'Microsoft Sans Serif', 'Microsoft YaHei',
        'Microsoft JhengHei', 'Mongolian Baiti', 'MS Gothic', 'MS PGothic',
        'MS Mincho', 'MV Boli', 'Myanmar Text', 'Nirmala UI',
        'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script',
        'Segoe UI Historic', 'Segoe UI Emoji', 'SimSun', 'Sitka', 'Sylfaen',
        'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
        'Webdings', 'Wingdings', 'Yu Gothic'],
      // What the bundle resolves for a macOS persona (the macOS allowlist).
      mac: ['Arial', 'Times New Roman', 'Courier New'],
      // Linux persona: the original Debian bundle set.
      linux: ['Arial', 'Times New Roman', 'Liberation Sans', 'Liberation Serif',
        'Liberation Mono', 'Arimo', 'Tinos', 'Cousine'],
    };
    const fontNames = uaWin ? fontCatalog.windows
      : (uaMac ? fontCatalog.mac : fontCatalog.linux);
    // Per-script probe text. The width probe must measure glyphs the target
    // face actually has: the per-script persona fonts (the Noto clones behind
    // Ebrima / Gadugi / ... and Noto Color Emoji behind Segoe UI Emoji) do NOT
    // carry basic Latin, so measuring the Latin string in them just measures
    // the per-glyph fallback (identical to the missing-font baseline) and
    // reports a present font as absent. Each script string is covered by the
    // clone (and by the real Windows font -- that is what the font is for).
    // Everything else measures the shared Latin string.
    const fontProbeText = {
      Ebrima: 'ߊߌߒߜߐ',
      Gadugi: 'ᎣᏍᏓᏱᎠ',
      'Javanese Text': 'ꦔꦏ꧀ꦗꦫ',
      'Leelawadee UI': 'กขคงจฉ',
      'MV Boli': 'މދނސް',
      'Myanmar Text': 'ကခဂဃ',
      'Nirmala UI': 'कखगघ',
      'Mongolian Baiti': 'ᠠᠳᠴᠸ',
      'Segoe UI Emoji': '\u{1F600}\u{1F601}',
    };
    const fontSpan = document.createElement('span');
    fontSpan.style.cssText = 'position:absolute;left:-9999px;white-space:nowrap;font-size:72px;';
    document.body.appendChild(fontSpan);
    const measureFont = (f, generic) => {
      fontSpan.textContent = fontProbeText[f] || 'mmmmmmmmmwwwwwwwwwwiiiilli';
      fontSpan.style.fontFamily = f + ', ' + generic;
      return fontSpan.offsetWidth;
    };
    // Two baselines: with the generic monospace fallback (forced to Courier
    // New by the persona patch) a target that IS Courier New -- or metric-
    // identical to it (Lucida Console) -- measures the same as the baseline.
    // The serif fallback resolves to a proportional face, which every persona
    // face differs from. Present = differs from EITHER baseline.
    const fontBaselineMono = measureFont('missing-font-xyz', 'monospace');
    const fontBaselineSerif = measureFont('missing-font-xyz', 'serif');
    r.fontSet = {};
    for (const f of fontNames) {
      try {
        r.fontSet[f] = measureFont(f, 'monospace') !== fontBaselineMono
          || measureFont(f, 'serif') !== fontBaselineSerif;
      } catch (e) { r.fontSet[f] = null; }
    }
    fontSpan.remove();
    // A real Windows 10/11 machine reports every core family as present; assert
    // the enumeration matches that (not just "one of them").
    r.fontsCoherent = fontNames.every(f => r.fontSet[f] === true);
  } catch (e) { r.fontSetError = String(e); r.fontsCoherent = false; }

  // --- 19. timing precision (clamped performance.now / forged timeline = tell) ---
  try {
    const perfT0 = performance.now();
    const perfSamples = [];
    for (let i = 0; i < 1000; i++) perfSamples.push(performance.now());
    const perfWallMs = performance.now() - perfT0;
    let perfMinDelta = Infinity;
    let perfZeroDeltas = 0;
    let perfNonZeroDeltas = 0;
    for (let i = 1; i < perfSamples.length; i++) {
      const d = perfSamples[i] - perfSamples[i - 1];
      if (d === 0) perfZeroDeltas++;
      else { perfNonZeroDeltas++; if (d < perfMinDelta) perfMinDelta = d; }
    }
    r.perfMinDelta = perfMinDelta === Infinity ? null : perfMinDelta;
    r.perfZeroDeltas = perfZeroDeltas;
    r.perfNonZeroDeltas = perfNonZeroDeltas;
    r.perfWallMs = perfWallMs;
    r.timeOriginDriftMs = performance.timeOrigin + performance.now() - Date.now();
  } catch (e) { r.timingError = String(e); }
  // The clamping invariant: NO delta strictly inside (0, 0.099) -- a clamped
  // timer only steps 0 or >= 0.1ms. A fully flat 1000-sample loop on a fast
  // machine is NOT a forged timeline (the loop fits inside one 0.1ms bucket);
  // it only counts as flat if the loop also spanned < 10ms of wall time with
  // zero ticks AND never ticked. (firstFlat alone was brittle: a fast box
  // produced 997 zero deltas + firstFlat=true on real Chrome 157.)
  r.timingPrecisionOk = (r.perfMinDelta == null || r.perfMinDelta >= 0.099)
    && (r.perfNonZeroDeltas > 0 || r.perfWallMs >= 10);
  r.timeOriginOk = Math.abs(r.timeOriginDriftMs) < 5000;

  // --- 20. screen/window coherence (avail>full, outer<inner, touch on desktop) ---
  r.screenFull = {w: screen.width, h: screen.height, aw: screen.availWidth,
    ah: screen.availHeight, cd: screen.colorDepth, pd: screen.pixelDepth};
  r.screenWindow = {dpr: window.devicePixelRatio, sx: window.screenX, sy: window.screenY,
    ow: window.outerWidth, oh: window.outerHeight, iw: window.innerWidth,
    ih: window.innerHeight, orient: screen.orientation && screen.orientation.angle};
  r.screenCoherent = r.screenFull.aw <= r.screenFull.w && r.screenFull.ah <= r.screenFull.h
    && r.screenFull.cd === r.screenFull.pd
    && r.screenWindow.ow >= r.screenWindow.iw && r.screenWindow.oh >= r.screenWindow.ih;
  r.touchPoints = navigator.maxTouchPoints;
  r.touchHandlers = 'ontouchstart' in window;
  r.touchCoherent = r.touchPoints === 0 && r.touchHandlers === false;

  // --- 21. audio signature (OfflineAudioContext sum + live-context shape) ---
  try {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineCtx) throw new Error('no OfflineAudioContext');
    const offlineCtx = new OfflineCtx(1, 44100, 44100);
    const offlineOsc = offlineCtx.createOscillator();
    offlineOsc.type = 'triangle';
    offlineOsc.frequency.value = 10000;
    const offlineComp = offlineCtx.createDynamicsCompressor();
    if (offlineComp.threshold) offlineComp.threshold.value = -50;
    if (offlineComp.knee) offlineComp.knee.value = 40;
    if (offlineComp.ratio) offlineComp.ratio.value = 12;
    if (offlineComp.attack) offlineComp.attack.value = 0;
    if (offlineComp.release) offlineComp.release.value = 0.25;
    offlineOsc.connect(offlineComp);
    offlineComp.connect(offlineCtx.destination);
    offlineOsc.start(0);
    const offlineRendered = await offlineCtx.startRendering();
    const offlineData = offlineRendered.getChannelData(0);
    r.audioSampleCount = offlineData.length;
    r.audioSampleRate = offlineCtx.sampleRate;
    r.audioSum = [...offlineData.slice(4500, 4600)].reduce((a, v) => a + v, 0);
    r.audioSignatureOk = r.audioSampleCount === 44100 && Number.isFinite(r.audioSum);
  } catch (e) { r.audioError = String(e); r.audioSignatureOk = false; }
  try {
    const LiveCtx = window.AudioContext || window.webkitAudioContext;
    if (!LiveCtx) throw new Error('no AudioContext');
    const liveCtx = new LiveCtx();
    r.audioChannels = liveCtx.destination.maxChannelCount;
    r.audioBaseLatency = liveCtx.baseLatency;
    r.audioState = liveCtx.state;
    if (liveCtx.close) liveCtx.close();
  } catch (e) { r.audioLiveError = String(e); }
  r.audioLiveOk = r.audioChannels === 2 && r.audioBaseLatency != null;

  // --- 22. codec matrix (must match the claimed browser; OSS Chromium lacks H.264) ---
  try {
    const codecVideo = document.createElement('video');
    const codecAudio = document.createElement('audio');
    r.codecH264 = !!codecVideo.canPlayType('video/mp4; codecs=avc1.42E01E');
    r.codecH264Hi = codecVideo.canPlayType('video/mp4; codecs=avc1.64001F');
    r.codecAac = codecAudio.canPlayType('audio/mp4; codecs=mp4a.40.2');
    r.codecVp9 = codecVideo.canPlayType('video/webm; codecs=vp9');
    r.codecVp8 = codecVideo.canPlayType('video/webm; codecs=vp8');
    r.codecOpus = codecAudio.canPlayType('audio/webm; codecs=opus');
    r.codecMseH264 = !!(window.MediaSource
      && MediaSource.isTypeSupported('video/mp4; codecs=avc1.42E01E'));
    r.codecRecorderWebm = !!(window.MediaRecorder && MediaRecorder.isTypeSupported('video/webm'));
    r.codecMatrixOk = r.codecH264 === true && r.codecH264Hi === 'probably'
      && r.codecMseH264 === true;
  } catch (e) { r.codecError = String(e); r.codecMatrixOk = false; }

  // --- 23. permissions state (a fresh profile is 'prompt' everywhere) ---
  try {
    r.permissionStates = {};
    for (const permName of ['geolocation', 'notifications', 'camera', 'microphone',
                            'clipboard-read', 'midi']) {
      try {
        r.permissionStates[permName] = (await navigator.permissions.query({name: permName})).state;
      } catch (e) { r.permissionStates[permName] = 'ERR:' + String(e).slice(0, 40); }
    }
    r.notificationPerm = typeof Notification !== 'undefined'
      ? Notification.permission : 'no-API';
    r.permissionsPrompt = r.permissionStates.geolocation === 'prompt'
      && r.permissionStates.notifications === 'prompt';
    r.notificationDefault = typeof Notification === 'function'
      && (r.notificationPerm === 'default' || r.notificationPerm === 'prompt');
  } catch (e) {
    r.permissionsError = String(e);
    r.permissionsPrompt = false;
    r.notificationDefault = false;
  }

  // --- 24. standard API presence + SAB/crossOriginIsolated pairing ---
  r.standardApis = {wasm: typeof WebAssembly, sab: typeof SharedArrayBuffer,
    atomics: typeof Atomics, webTransport: typeof WebTransport,
    mediaRecorder: typeof MediaRecorder, mediaSource: typeof MediaSource,
    intersectionObserver: typeof IntersectionObserver,
    performanceObserver: typeof PerformanceObserver, localStorage: typeof localStorage,
    indexedDB: typeof indexedDB, caches: typeof caches};
  r.crossOriginIsolated = crossOriginIsolated;
  r.standardPresenceOk = (r.standardApis.sab !== 'undefined') === !!r.crossOriginIsolated
    && r.standardApis.wasm === 'object' && r.standardApis.atomics === 'object';

  // --- 25. device APIs (desktop Chrome exposes all; bluetooth + real Array gamepads) ---
  try {
    r.deviceApiTypes = {gamepads: typeof navigator.getGamepads, usb: typeof navigator.usb,
      bluetooth: typeof navigator.bluetooth, midi: typeof navigator.requestMIDIAccess,
      serial: typeof navigator.serial, hid: typeof navigator.hid};
    r.deviceApiPresenceOk = r.deviceApiTypes.gamepads === 'function'
      && r.deviceApiTypes.usb === 'object' && r.deviceApiTypes.midi === 'function';
    r.bluetoothOk = r.deviceApiTypes.bluetooth === 'object'
      && typeof navigator.bluetooth.getAvailability === 'function';
    r.gamepadArrayClass = Object.prototype.toString.call(navigator.getGamepads());
    r.gamepadsOk = Array.isArray(navigator.getGamepads())
      && r.gamepadArrayClass === '[object Array]';
  } catch (e) {
    r.deviceApiError = String(e);
    r.deviceApiPresenceOk = false;
    r.bluetoothOk = false;
    r.gamepadsOk = false;
  }
  try {
    const mediaDevices = await navigator.mediaDevices.enumerateDevices();
    r.mediaDeviceCount = mediaDevices.length;
    r.mediaDeviceKinds = mediaDevices.map(d => d.kind);
    r.mediaDevicesOk = r.mediaDeviceCount > 0 && r.mediaDeviceKinds
      .every(k => ['audioinput', 'videoinput', 'audiooutput'].includes(k));
  } catch (e) { r.mediaDevicesError = String(e); r.mediaDevicesOk = false; }

  // --- 26. storage quota (nonzero quota; the exact cap is recorded, a shape tell) ---
  try {
    r.storageAvailable = 'storage' in navigator;
    const storageEstimate = r.storageAvailable ? await navigator.storage.estimate() : null;
    r.storageQuota = storageEstimate ? storageEstimate.quota : null;
    r.storageUsage = storageEstimate ? storageEstimate.usage : null;
    r.storageUsageDetails = storageEstimate ? (storageEstimate.usageDetails || {}) : null;
    r.storageEstimateOk = r.storageAvailable && r.storageQuota > 0;
  } catch (e) { r.storageError = String(e); r.storageEstimateOk = false; }

  // --- 27. runtime artifacts (global pollution, native getters & toString) ---
  try {
    const pollutionSig = /cdc_|__driver|selenium|phantom|nightmare|domAutomation|__selenium|_rec|__fxdriver|webdriver/i;
    const windowKeys = Object.keys(window);
    r.windowKeyCount = windowKeys.length;
    r.pollutionHits = windowKeys.filter(k => pollutionSig.test(k));
    r.globalPollutionOk = r.pollutionHits.length === 0;
  } catch (e) { r.globalPollutionOk = false; }
  try {
    const hcDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'hardwareConcurrency');
    const platformDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
    r.hcGetterCode = hcDescriptor && hcDescriptor.get
      ? hcDescriptor.get.toString().slice(0, 80) : null;
    r.platformGetterCode = platformDescriptor && platformDescriptor.get
      ? platformDescriptor.get.toString().slice(0, 80) : null;
    r.propertyDescriptorOk = (r.hcGetterCode || '').includes('[native code]')
      && (r.platformGetterCode || '').includes('[native code]')
      && typeof navigator.hardwareConcurrency === 'number';
  } catch (e) { r.propertyDescriptorOk = false; }
  try {
    const toStringTargets = {canPlayType: HTMLMediaElement.prototype.canPlayType,
      toDataURL: HTMLCanvasElement.prototype.toDataURL,
      getChannelData: AudioBuffer.prototype.getChannelData,
      permissionsQuery: navigator.permissions.query,
      enumerateDevices: navigator.mediaDevices.enumerateDevices,
      performanceNow: performance.now,
      requestAnimationFrame: window.requestAnimationFrame};
    r.toStringIntegrity = Object.fromEntries(Object.entries(toStringTargets)
      .map(([k, v]) => [k, String(v).includes('[native code]')]));
    r.toStringIntegrityOk = Object.values(r.toStringIntegrity).every(v => v === true);
  } catch (e) { r.toStringIntegrityOk = false; }
  try {
    r.evalIntegrityOk = window.eval.toString().includes('[native code]')
      && window.eval === eval;
  } catch (e) { r.evalIntegrityOk = false; }
  try {
    r.constructorNames = {navigator: navigator.constructor.name,
      screen: screen.constructor.name, document: document.constructor.name,
      permissions: navigator.permissions.constructor.name};
    r.constructorNamesOk = r.constructorNames.navigator === 'Navigator'
      && r.constructorNames.screen === 'Screen'
      && ['Document', 'HTMLDocument'].includes(r.constructorNames.document)
      && r.constructorNames.permissions === 'Permissions';
  } catch (e) { r.constructorNamesOk = false; }
  try {
    r.schedulingTypes = {isInputPending: navigator.scheduling
      ? typeof navigator.scheduling.isInputPending : null,
      idleDetector: typeof IdleDetector};
    r.schedulingOk = r.schedulingTypes.idleDetector === 'function'
      && r.schedulingTypes.isInputPending === 'function';
  } catch (e) { r.schedulingOk = false; }

  // --- 28. visibility + rAF (frozen rendering = headless tell) ---
  r.visibilityState = document.visibilityState;
  r.documentHidden = document.hidden;
  r.documentHasFocus = document.hasFocus();
  r.visibilityOk = r.visibilityState === 'visible' && r.documentHidden === false
    && r.documentHasFocus === true;
  try {
    r.rafFrames = await new Promise(resolve => {
      let rafCount = 0;
      const rafTick = () => {
        if (++rafCount >= 3) { resolve(rafCount); return; }
        requestAnimationFrame(rafTick);
      };
      requestAnimationFrame(rafTick);
      setTimeout(() => resolve(rafCount), 4000);
    });
  } catch (e) { r.rafError = String(e); }
  r.rafRunning = r.rafFrames >= 3;

  // --- 29. persona coherence: navigator.platform must match the UA-CH platform ---
  r.uachPlatform = navigator.userAgentData && navigator.userAgentData.platform;
  r.platformUachOk = (r.uachPlatform === 'Windows' && /^Win/i.test(navigator.platform))
    || (r.uachPlatform === 'macOS' && /^Mac/i.test(navigator.platform))
    || !['Windows', 'macOS'].includes(r.uachPlatform);

  // --- 30. EME/Widevine + WebCodecs HW flags + WebAuthn platform authenticator ---
  try {
    const emeCaps = {initDataTypes: ['cenc'],
      audioCapabilities: [{contentType: 'audio/mp4; codecs="mp4a.40.2"'}],
      videoCapabilities: [{contentType: 'video/mp4; codecs="avc1.42E01E"'}]};
    r.widevine = {};
    if (navigator.requestMediaKeySystemAccess) {
      for (const emeRobustness of ['', 'SW_SECURE_CRYPTO', 'SW_SECURE_DECODE',
                                   'HW_SECURE_ALL', 'HW_SECURE_DECODE', 'HW_SECURE_CRYPTO']) {
        const emeCfg = JSON.parse(JSON.stringify(emeCaps));
        if (emeRobustness !== '') emeCfg.videoCapabilities[0].robustness = emeRobustness;
        try {
          const emeAccess = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [emeCfg]);
          const emeConf = await emeAccess.getConfiguration();
          r.widevine[emeRobustness || 'default'] = emeConf.videoCapabilities
            .map(v => v.robustness || 'none');
        } catch (e) { r.widevine[emeRobustness || 'default'] = 'NO-ACCESS:' + (e && e.name); }
      }
    }
    // a desktop persona (Windows/macOS) must at least resolve com.widevine.alpha
    // with SW robustness (a live CDM); real stock Chrome does NOT accept
    // HW_SECURE_* at requestMediaKeySystemAccess level -- HW acceptance is a
    // recorded signal, not an assertion.
    const desktopPersona = ['Windows', 'macOS'].includes(r.uachPlatform);
    r.widevineL1Ok = !desktopPersona || (r.widevine.default != null
      && !String(r.widevine.default).startsWith('NO-ACCESS')
      && !String(r.widevine.SW_SECURE_CRYPTO || '').startsWith('NO-ACCESS'));
    try {
      const clearKeyAccess = await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [emeCaps]);
      const clearKeyConf = await clearKeyAccess.getConfiguration();
      r.clearKey = clearKeyConf.videoCapabilities.map(v => v.robustness || 'none');
    } catch (e) { r.clearKey = 'NO-ACCESS:' + (e && e.name); }
    r.clearKeyOk = Array.isArray(r.clearKey);
    // playready is an OS identity signal -- recorded, not asserted.
    try {
      const playreadyAccess = await navigator.requestMediaKeySystemAccess('com.microsoft.playready', [emeCaps]);
      const playreadyConf = await playreadyAccess.getConfiguration();
      r.playready = playreadyConf.videoCapabilities.map(v => v.robustness || 'none');
    } catch (e) { r.playready = 'NO-ACCESS:' + (e && e.name); }
  } catch (e) { r.emeError = String(e); r.widevineL1Ok = false; r.clearKeyOk = false; }
  try {
    r.webCodecsPresent = !!window.VideoDecoder && !!window.VideoEncoder;
    r.webCodecsDecode = null;
    if (r.webCodecsPresent) {
      try {
        const decodeHw = await VideoDecoder.isConfigSupported(
          {codec: 'avc1.640028', hardwareAcceleration: 'prefer-hardware'});
        const decodeAny = await VideoDecoder.isConfigSupported({codec: 'avc1.640028'});
        r.webCodecsDecode = {anySupported: decodeAny.supported, hwSupported: decodeHw.supported,
          hwFlag: decodeHw.config && decodeHw.config.hardwareAcceleration || null};
      } catch (e) { r.webCodecsDecode = 'ERR:' + (e && e.name); }
    }
    r.webCodecsDecodeOk = r.webCodecsPresent && r.webCodecsDecode
      && r.webCodecsDecode.anySupported === true;
  } catch (e) { r.webCodecsError = String(e); r.webCodecsDecodeOk = false; }
  try {
    r.webAuthnPresent = typeof window.PublicKeyCredential === 'function'
      && !!(navigator.credentials && navigator.credentials.create);
    if (r.webAuthnPresent) {
      try {
        r.webAuthnPlatformAuth = await PublicKeyCredential
          .isUserVerifyingPlatformAuthenticatorAvailable();
      } catch (e) { r.webAuthnPlatformAuth = 'ERR:' + (e && e.name); }
    }
    r.webAuthnOk = r.webAuthnPresent === true;
  } catch (e) { r.webAuthnError = String(e); r.webAuthnOk = false; }

  // --- 31. mediaCapabilities / GPU truth (powerEfficient=false = no real GPU) ---
  try {
    r.mediaCapabilitiesPresent = !!navigator.mediaCapabilities;
    r.mediaCapabilities = null;
    if (r.mediaCapabilitiesPresent) {
      try {
        const decodeInfo = await navigator.mediaCapabilities.decodingInfo({type: 'file',
          video: {contentType: 'video/mp4; codecs=avc1.640028', width: 1920, height: 1080,
                  bitrate: 5000000, framerate: 30}});
        r.mediaCapabilities = {supported: decodeInfo.supported, smooth: decodeInfo.smooth,
          powerEfficient: decodeInfo.powerEfficient};
      } catch (e) { r.mediaCapabilitiesError = String(e); }
    }
    r.mediaCapabilitiesOk = r.mediaCapabilitiesPresent
      && !!r.mediaCapabilities && r.mediaCapabilities.supported != null;
  } catch (e) { r.mediaCapabilitiesOk = false; }

  // --- 32. speech voices / connection info / keyboard layout ---
  try {
    if (!window.speechSynthesis) throw new Error('no speechSynthesis');
    const waitMs = ms => new Promise(res => setTimeout(res, ms));
    let speechVoices = speechSynthesis.getVoices();
    if (!speechVoices || !speechVoices.length) {
      await waitMs(400); speechVoices = speechSynthesis.getVoices();
    }
    if (!speechVoices || !speechVoices.length) {
      await waitMs(600); speechVoices = speechSynthesis.getVoices();
    }
    r.speechVoiceCount = speechVoices ? speechVoices.length : 0;
    r.speechVoiceLangs = speechVoices ? [...new Set(speechVoices.map(v => v.lang))] : [];
    r.speechVoicesOk = r.speechVoiceCount > 0;
  } catch (e) { r.speechVoicesError = String(e); r.speechVoicesOk = false; }
  try {
    const netConnection = navigator.connection;
    r.networkInfo = netConnection
      ? {effectiveType: netConnection.effectiveType, downlink: netConnection.downlink,
         rtt: netConnection.rtt, saveData: netConnection.saveData}
      : null;
    r.networkInfoOk = !!r.networkInfo && r.networkInfo.effectiveType != null
      && typeof r.networkInfo.downlink === 'number' && typeof r.networkInfo.rtt === 'number';
  } catch (e) { r.networkInfoOk = false; }
  try {
    if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) throw new Error('no keyboard API');
    const keyLayout = await navigator.keyboard.getLayoutMap();
    r.keyLayoutW = keyLayout.get('KeyW');
    r.keyLayoutZ = keyLayout.get('KeyZ');
    r.keyboardLayoutOk = r.keyLayoutW === 'w';
  } catch (e) { r.keyboardLayoutError = String(e); r.keyboardLayoutOk = false; }

  // --- 33. high-entropy UA-CH (real Chrome legitimately lists Chromium next to
  //         Google Chrome in the brand lists -- that is never a failure here) ---
  try {
    if (!navigator.userAgentData || !navigator.userAgentData.getHighEntropyValues) {
      throw new Error('no UA-CH');
    }
    r.highEntropyUa = await navigator.userAgentData.getHighEntropyValues(
      ['architecture', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'model',
       'bitness', 'wow64']);
    r.highEntropyUaOk = !!r.highEntropyUa && r.highEntropyUa.architecture != null
      && r.highEntropyUa.platformVersion != null;
  } catch (e) { r.highEntropyUaError = String(e); r.highEntropyUaOk = false; }
  try {
    r.perfMemory = performance.memory
      ? {limit: performance.memory.jsHeapSizeLimit,
         total: performance.memory.totalJSHeapSize, used: performance.memory.usedJSHeapSize}
      : null;
    r.perfMemoryOk = !!r.perfMemory && r.perfMemory.limit > 1e9;
  } catch (e) { r.perfMemoryOk = false; }
  try {
    if (typeof MediaSource === 'undefined') throw new Error('no MediaSource');
    r.hvcAc3Matrix = {};
    for (const msType of ['video/mp4; codecs="hvc1.1.6.L93.B0"',
                          'video/mp4; codecs="hvc1.1.6.L120.90"',
                          'video/mp4; codecs="dvh1.05.03"', 'audio/mp4; codecs="ac-3"',
                          'audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="mp4a.a5"']) {
      r.hvcAc3Matrix[msType] = MediaSource.isTypeSupported(msType);
    }
    r.hvcAc3Ok = typeof r.hvcAc3Matrix['video/mp4; codecs="hvc1.1.6.L93.B0"'] === 'boolean';
  } catch (e) { r.hvcAc3Error = String(e); r.hvcAc3Ok = false; }
  try {
    r.newApiPresence = {startViewTransition: typeof document.startViewTransition,
      paintWorklet: typeof CSS.paintWorklet, highlights: typeof CSS.highlights,
      mediaSession: typeof navigator.mediaSession, wakeLock: typeof navigator.wakeLock,
      clipboard: typeof navigator.clipboard};
    r.newApiPresenceOk = r.newApiPresence.startViewTransition === 'function'
      && r.newApiPresence.mediaSession === 'object' && r.newApiPresence.clipboard === 'object'
      && r.newApiPresence.wakeLock === 'object';
  } catch (e) { r.newApiPresenceOk = false; }

  // --- 34. GPU readback timing (software vs real GPU has characteristic shapes) ---
  try {
    const rbCanvas = document.createElement('canvas');
    rbCanvas.width = 300; rbCanvas.height = 150;
    const rbCtx = rbCanvas.getContext('2d');
    if (!rbCtx) throw new Error('no-2d');
    rbCtx.font = '24px Arial';
    rbCtx.fillStyle = '#f60';
    rbCtx.fillText('battery canvas probe', 4, 33);
    const rbPercentile = (a, p) => a[Math.floor(a.length * p)];
    const rb2dSamples = [];
    for (let i = 0; i < 50; i++) {
      const s = performance.now(); rbCanvas.toDataURL(); rb2dSamples.push(performance.now() - s);
    }
    rb2dSamples.sort((a, b) => a - b);
    r.readbackT2d = {p50: rbPercentile(rb2dSamples, 0.5), p95: rbPercentile(rb2dSamples, 0.95)};
    const rbGlCanvas = document.createElement('canvas');
    rbGlCanvas.width = 256; rbGlCanvas.height = 256;
    const rbGl = rbGlCanvas.getContext('webgl2') || rbGlCanvas.getContext('webgl');
    if (rbGl) {
      rbGl.clearColor(0.3, 0.5, 0.7, 1);
      rbGl.clear(rbGl.COLOR_BUFFER_BIT);
      const rbBuf = new Uint8Array(256 * 256 * 4);
      const rbGlSamples = [];
      for (let i = 0; i < 50; i++) {
        const s = performance.now();
        rbGl.readPixels(0, 0, 256, 256, rbGl.RGBA, rbGl.UNSIGNED_BYTE, rbBuf);
        rbGlSamples.push(performance.now() - s);
      }
      rbGlSamples.sort((a, b) => a - b);
      r.readbackWebgl = {p50: rbPercentile(rbGlSamples, 0.5), p95: rbPercentile(rbGlSamples, 0.95)};
    }
    r.gpuReadbackTimingOk = !!r.readbackT2d && r.readbackT2d.p50 != null
      && r.readbackT2d.p95 != null && (!r.readbackWebgl || r.readbackWebgl.p50 != null);
  } catch (e) { r.readbackError = String(e); r.gpuReadbackTimingOk = false; }

  // --- 35. local video pipeline (vp8 encode->decode roundtrip, playback quality) ---
  try {
    if (!window.VideoDecoder || !window.VideoEncoder || !window.VideoFrame) {
      throw new Error('no WebCodecs');
    }
    const rtChunks = [];
    const rtCanvas = document.createElement('canvas');
    rtCanvas.width = 320; rtCanvas.height = 180;
    const rtCtx = rtCanvas.getContext('2d');
    rtCtx.fillStyle = '#223';
    rtCtx.fillRect(0, 0, 320, 180);
    rtCtx.fillStyle = '#f62';
    for (let i = 0; i < 20; i++) rtCtx.fillRect(i * 16, (i * 9) % 180, 8, 8);
    const rtEncoder = new VideoEncoder({output: chunk => {
      const rtData = new Uint8Array(chunk.byteLength);
      chunk.copyTo(rtData);
      rtChunks.push({type: chunk.type, ts: chunk.timestamp, data: rtData});
    }, error: () => {}});
    rtEncoder.configure({codec: 'vp8', width: 320, height: 180, framerate: 30, bitrate: 1000000});
    for (let i = 0; i < 10; i++) {
      const rtFrame = new VideoFrame(rtCanvas, {timestamp: i * 33333});
      rtEncoder.encode(rtFrame);
      rtFrame.close();
    }
    await rtEncoder.flush();
    rtEncoder.close();
    let rtDecoded = 0;
    const rtDecoder = new VideoDecoder({output: f => { rtDecoded++; f.close(); }, error: () => {}});
    rtDecoder.configure({codec: 'vp8'});
    for (const rtChunk of rtChunks) {
      try {
        rtDecoder.decode(new EncodedVideoChunk(
          {type: rtChunk.type, timestamp: rtChunk.ts, data: rtChunk.data}));
      } catch (e) { r.videoRoundtripErrors = String(e).name; }
    }
    await rtDecoder.flush();
    rtDecoder.close();
    r.videoRoundtrip = {chunks: rtChunks.length, decoded: rtDecoded};
    r.videoRoundtripOk = r.videoRoundtrip.chunks === 10 && r.videoRoundtrip.decoded === 10;
  } catch (e) { r.videoRoundtripError = String(e); r.videoRoundtripOk = false; }
  try {
    if (!HTMLVideoElement.prototype.requestVideoFrameCallback) throw new Error('no rVFC');
    const pqCanvas = document.createElement('canvas');
    pqCanvas.width = 320; pqCanvas.height = 180;
    const pqCtx = pqCanvas.getContext('2d');
    const pqRecorder = new MediaRecorder(pqCanvas.captureStream(30),
                                         {mimeType: 'video/webm;codecs=vp8'});
    const pqParts = [];
    pqRecorder.ondataavailable = e => pqParts.push(e.data);
    pqRecorder.start();
    let pqDrawn = 0;
    const pqDraw = () => {
      if (pqDrawn < 30) {
        pqCtx.fillStyle = 'rgb(' + (pqDrawn * 8 % 255) + ',' + (pqDrawn * 4 % 255) + ',64)';
        pqCtx.fillRect((pqDrawn * 10) % 320, (pqDrawn * 6) % 180, 40, 40);
        pqDrawn++;
        requestAnimationFrame(pqDraw);
      }
    };
    requestAnimationFrame(pqDraw);
    await new Promise(res => setTimeout(res, 700));
    pqRecorder.stop();
    await new Promise(res => { pqRecorder.onstop = res; setTimeout(res, 2000); });
    const pqVideo = document.createElement('video');
    pqVideo.muted = true;
    pqVideo.playsInline = true;
    pqVideo.src = URL.createObjectURL(new Blob(pqParts, {type: 'video/webm'}));
    await new Promise(res => {
      pqVideo.onloadedmetadata = res; pqVideo.onerror = res; setTimeout(res, 5000);
    });
    if (!pqVideo.videoWidth) throw new Error('no video metadata');
    await pqVideo.play();
    let rVfcCount = 0;
    await new Promise(res => {
      const rVfc = () => {
        rVfcCount++;
        if (rVfcCount < 20) pqVideo.requestVideoFrameCallback(rVfc); else res();
      };
      pqVideo.requestVideoFrameCallback(rVfc);
      setTimeout(res, 8000);
    });
    const pqStats = pqVideo.getVideoPlaybackQuality();
    r.playbackQuality = {total: pqStats.totalVideoFrames, dropped: pqStats.droppedVideoFrames,
      corrupted: pqStats.corruptedVideoFrames};
    r.rvfcFrames = rVfcCount;
    try { pqVideo.pause(); URL.revokeObjectURL(pqVideo.src); } catch (e) { /* ignore */ }
    r.playbackQualityOk = !!r.playbackQuality && r.playbackQuality.total != null
      && (r.playbackQuality.dropped || 0) <= r.playbackQuality.total && r.rvfcFrames >= 2;
  } catch (e) { r.playbackError = String(e); r.playbackQualityOk = false; }

  // --- 36. CDP/automation-leak surfaces (deeper than the single Error probe) ---
  try {
    // match injection-style names the cdc_/__patchright/__cdp/__pw_* families
    // actually use; the explicit-injection list catches bare-name globals the
    // regex wouldn't (e.g. window.cdp)
    const leakSig = /^(_?_?(cdp|pw|playwright|patchright|puppeteer|pptr|driver|selenium|phantom|nightmare|automation|recorder|protocol|inject)|cdc_|_rec$)/i;
    r.cdpWindowEnumHits = Object.keys(window).filter(k => leakSig.test(k));
    r.cdpGlobalEnumHits = Object.getOwnPropertyNames(globalThis).filter(k => leakSig.test(k));
    r.cdpNavigatorEnumHits = Object.getOwnPropertyNames(navigator).filter(k => leakSig.test(k));
    r.cdpDocumentEnumHits = Object.getOwnPropertyNames(document).filter(k => leakSig.test(k));
    r.cdpInjectedGlobals = ['__cdp', '__cdp_', '__patchright', '__playwright', '__pw',
      '__puppeteer', 'cdp', 'CDPState', 'InjectedUtil', '__protocol']
      .filter(k => k in globalThis);
    r.cdpEnumOk = r.cdpWindowEnumHits.length === 0 && r.cdpGlobalEnumHits.length === 0
      && r.cdpNavigatorEnumHits.length === 0 && r.cdpDocumentEnumHits.length === 0
      && r.cdpInjectedGlobals.length === 0;
  } catch (e) { r.cdpEnumError = String(e); r.cdpEnumOk = false; }

  // synthetic events must stay untrusted: real Chrome reports isTrusted=false
  // for dispatchEvent/createEvent, and Event.prototype.isTrusted must stay a
  // native getter -- automation stacks that rewrite it leak the rewrite.
  try {
    const trustTarget = document.createElement('div');
    let trustListenerEvent = null;
    const trustListener = ev => { trustListenerEvent = ev; };
    trustTarget.addEventListener('stealth-probe-trust', trustListener);
    const trustSynthetic = new Event('stealth-probe-trust');
    trustTarget.dispatchEvent(trustSynthetic);
    trustTarget.removeEventListener('stealth-probe-trust', trustListener);
    const trustLegacy = document.createEvent('Event');
    trustLegacy.initEvent('stealth-probe-trust');
    r.syntheticIsTrusted = trustSynthetic.isTrusted;            // want false
    r.listenerIsTrusted = trustListenerEvent && trustListenerEvent.isTrusted;
    r.legacyIsTrusted = trustLegacy.isTrusted;                  // want false
    // isTrusted is a [LegacyUnforgeable] IDL attribute: it lives as an own
    // accessor on each Event INSTANCE, never on Event.prototype. Probe the
    // instance's own descriptor (the prototype lookup is undefined even in
    // stock Chrome -- verified on 157.0.8103.38).
    var trustDescriptor = Object.getOwnPropertyDescriptor(trustSynthetic, 'isTrusted');
    r.isTrustedGetterNative = !!(trustDescriptor && trustDescriptor.get
      && String(trustDescriptor.get).includes('[native code]'));
    r.eventTrustOk = r.syntheticIsTrusted === false && r.listenerIsTrusted === false
      && r.legacyIsTrusted === false && r.isTrustedGetterNative === true;
  } catch (e) { r.eventTrustError = String(e); r.eventTrustOk = false; }

  // stack traces from several error origins; no framework frame names.
  // Deliberately NOT matching 'eval at <anonymous>' -- a plain eval'd error
  // shows that in stock Chrome too.
  try {
    const sampleStack = fn => {
      try { fn(); } catch (e) { return e.stack || ''; }
      return '';
    };
    const stackPaths = {
      typeError: sampleStack(() => { null.prop; }),
      jsonParse: sampleStack(() => { JSON.parse('{bad'); }),
      evalError: sampleStack(() => { eval('null.prop'); }),
      rangeError: sampleStack(() => { [].flat(Infinity).length; }),
      asyncError: '',
    };
    await new Promise(res => {
      Promise.reject(new Error('async-path')).catch(e => {
        stackPaths.asyncError = e.stack || ''; res();
      });
      setTimeout(res, 1000);
    });
    const stackLeakSig = /patchright|playwright|puppeteer|pptr:|__puppeteer|cdp_|CDPState|InjectedScript|chromium/i;
    r.stackSamples = Object.fromEntries(Object.entries(stackPaths)
      .map(([k, v]) => [k, v.slice(0, 200)]));
    r.stackLeakPaths = Object.entries(stackPaths).filter(([_, v]) => stackLeakSig.test(v))
      .map(([k]) => k);
    r.stackTracesOk = r.stackLeakPaths.length === 0;
  } catch (e) { r.stackTracesError = String(e); r.stackTracesOk = false; }

  // --- 38. CSS media queries (detection-gaps row 20: zero coverage before this) ---
  // FingerprintJS OSS reads 5+ of these directly; CreepJS's prefersLightColor
  // reads (prefers-color-scheme). Assert the values are well-formed and
  // desktop-coherent: exactly one of light/dark, no forced colors, a COLOR
  // display (monochrome: 0 matches), and at least srgb gamut.
  try {
    const mediaMatch = q => { try { return matchMedia(q).matches; } catch (e) { return null; } };
    r.mediaQueries = {
      prefersColorScheme: mediaMatch('(prefers-color-scheme: dark)') === true ? 'dark'
        : (mediaMatch('(prefers-color-scheme: light)') === true ? 'light' : 'none'),
      forcedColors: mediaMatch('(forced-colors: active)') === true ? 'active' : 'none',
      monochrome: mediaMatch('(monochrome: 0)') === true,  // 0 = color display
      displayGamutSrgb: mediaMatch('(display-gamut: srgb)') === true,
      invertedColors: mediaMatch('(inverted-colors: inverted)') === true,  // recorded
    };
    r.mediaQueriesOk = ['light', 'dark'].includes(r.mediaQueries.prefersColorScheme)
      && ['none', 'active'].includes(r.mediaQueries.forcedColors)
      && r.mediaQueries.monochrome === true
      && r.mediaQueries.displayGamutSrgb === true;
  } catch (e) { r.mediaQueriesError = String(e); r.mediaQueriesOk = false; }

  // System colors: the persona OS's ui::NativeTheme decides these. The known
  // cross-OS tell is ActiveText: Linux/Xvfb answers rgb(255,0,0) while a
  // genuine Windows desktop answers rgb(0,102,204) (CreepJS hasKnownBgColor).
  // Every system color must resolve to a real (non-transparent) color.
  try {
    const sysColorEl = document.createElement('div');
    document.body.appendChild(sysColorEl);
    const sysColorNames = ['AccentColor', 'AccentColorText', 'ActiveText',
      'ButtonBorder', 'ButtonFace', 'ButtonText', 'Canvas', 'CanvasText',
      'Field', 'FieldText', 'GrayText', 'Highlight', 'HighlightText',
      'InfoBackground', 'InfoText', 'LinkText', 'Mark', 'MarkText', 'VisitedText'];
    r.systemColors = {};
    for (const sysColorName of sysColorNames) {
      sysColorEl.style.color = sysColorName;
      r.systemColors[sysColorName] = getComputedStyle(sysColorEl).color;
    }
    sysColorEl.remove();
    const sysColorTransparent = c => !c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
    const sysColorNorm = c => String(c || '').replace(/\s+/g, '');
    r.systemColorsOk = sysColorNames.every(n => !sysColorTransparent(r.systemColors[n]))
      && (r.uachPlatform !== 'Windows'
        || sysColorNorm(r.systemColors.ActiveText) === 'rgb(0,102,204)');
  } catch (e) { r.systemColorsError = String(e); r.systemColorsOk = false; }

  // --- 39. Intl timezone + depth (detection-gaps row 22: the battery never
  // read the exact timezone_mismatch input) ---
  // resolvedOptions().timeZone must be a real IANA zone (not Etc/Unknown, not
  // empty) and must be one Intl itself supports.
  try {
    r.intlTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    r.intlTimezoneOk = typeof r.intlTimeZone === 'string' && r.intlTimeZone.length > 0
      && r.intlTimeZone !== 'Etc/Unknown'
      && Intl.supportedValuesOf('timeZone').includes(r.intlTimeZone);
  } catch (e) { r.intlTimezoneError = String(e); r.intlTimezoneOk = false; }
  // formatToParts: the typed-ctor route must produce the full part-type set.
  try {
    r.intlFormatParts = new Intl.DateTimeFormat('en-US',
      {year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric',
       minute: '2-digit', second: '2-digit', weekday: 'long'})
      .formatToParts(new Date()).map(p => p.type);
    r.intlFormatPartsOk = ['year', 'month', 'day', 'hour', 'minute', 'second', 'weekday']
      .every(t => r.intlFormatParts.includes(t));
  } catch (e) { r.intlFormatPartsError = String(e); r.intlFormatPartsOk = false; }
  // A second collation angle beyond the sv/en o-diaeresis pair: case ordering.
  try {
    r.intlCaseFirst = new Intl.Collator('de', {caseFirst: 'upper'}).compare('a', 'A');
    r.intlCaseFirstOk = r.intlCaseFirst > 0;
  } catch (e) { r.intlCaseFirstError = String(e); r.intlCaseFirstOk = false; }
  r.intlTimezoneOk = r.intlTimezoneOk === true && r.intlFormatPartsOk === true
    && r.intlCaseFirstOk === true;

  // --- 40. WebRTC depth (detection-gaps row 24: beyond the ICE-IP check) ---
  // getCapabilities codec lists, SDP rtpmap coherence with those lists, and
  // the DTLS/SRTP cipher suites a connected transport must report.
  try {
    const rtcsCaps = (typeof RTCRtpSender === 'function' && RTCRtpSender.getCapabilities)
      ? RTCRtpSender : null;
    const videoCaps = rtcsCaps ? (rtcsCaps.getCapabilities('video') || {codecs: []}) : {codecs: []};
    const audioCaps = rtcsCaps ? (rtcsCaps.getCapabilities('audio') || {codecs: []}) : {codecs: []};
    r.webrtcVideoCaps = videoCaps.codecs.map(c => (c.mimeType || '').toUpperCase());
    r.webrtcAudioCaps = audioCaps.codecs.map(c => (c.mimeType || '').toUpperCase());
    r.webrtcCapsOk = r.webrtcVideoCaps.includes('VIDEO/VP8')
      && r.webrtcVideoCaps.includes('VIDEO/VP9') && r.webrtcVideoCaps.includes('VIDEO/H264')
      && r.webrtcAudioCaps.includes('AUDIO/OPUS');
    // The SDP offer's rtpmap set must be the same codec universe as the
    // capability table (a spoofed/partial stack diverges here).
    const sdpPc = new RTCPeerConnection({iceServers: []});
    sdpPc.addTransceiver('audio');
    sdpPc.addTransceiver('video');
    const sdpOffer = await sdpPc.createOffer();
    sdpPc.close();
    const rtpMapCodecs = (sdpOffer.sdp || '').split('\n')
      .filter(l => l.startsWith('a=rtpmap:'))
      .map(l => (l.split(' ')[1] || '').split('/')[0].toUpperCase());
    r.webrtcSdpRtpMaps = rtpMapCodecs;
    r.webrtcSdpOk = rtpMapCodecs.includes('OPUS') && rtpMapCodecs.includes('VP8')
      && rtpMapCodecs.every(c => r.webrtcVideoCaps.includes('VIDEO/' + c)
        || r.webrtcAudioCaps.includes('AUDIO/' + c));
    // A connected transport must expose dtlsCipher + srtpCipher. If the PC
    // never connects (no network), the cipher assertion is inconclusive.
    r.webrtcStatsCiphers = null;
    r.webrtcDtlsCiphers = null;
    const statsPc = new RTCPeerConnection({
      iceServers: [{urls: 'stun:stun.l.google.com:19302'}]});
    statsPc.createDataChannel('stealth-probe-stats');
    await statsPc.setLocalDescription(await statsPc.createOffer());
    const statsConnected = await new Promise(res => {
      if (statsPc.connectionState === 'connected') return res(true);
      statsPc.onconnectionstatechange = () => {
        if (statsPc.connectionState === 'connected') res(true);
      };
      setTimeout(() => res(false), 8000);
    });
    r.webrtcStatsConnected = statsConnected;
    if (statsConnected) {
      const statsReport = await statsPc.getStats();
      const statsTransports = [...statsReport.values()].filter(s => s.type === 'transport');
      r.webrtcStatsCiphers = statsTransports.map(t => t.srtpCipher || null);
      r.webrtcDtlsCiphers = statsTransports.map(t => t.dtlsCipher || null);
    }
    statsPc.close();
    r.webrtcStatsOk = !statsConnected
      || (r.webrtcStatsCiphers && r.webrtcStatsCiphers.some(c => /AES/i.test(String(c || ''))));
  } catch (e) {
    r.webrtcDepthError = String(e);
    r.webrtcCapsOk = false;
    r.webrtcSdpOk = false;
    r.webrtcStatsOk = false;
  }
  r.webrtcDepthOk = r.webrtcCapsOk === true && r.webrtcSdpOk === true
    && r.webrtcStatsOk === true;

  // --- 41. sensors + misc presence (detection-gaps row 27) ---
  // Sensor constructors must EXIST on desktop Chrome but their events must
  // never FIRE (no motion sensors on a desktop). Then the misc presence set.
  try {
    r.sensorTypes = {accelerometer: typeof Accelerometer, gyroscope: typeof Gyroscope,
      magnetometer: typeof Magnetometer, deviceOrientation: typeof DeviceOrientationEvent,
      deviceMotion: typeof DeviceMotionEvent};
    r.sensorEventsFired = await new Promise(res => {
      let sensorEventCount = 0;
      const sensorListener = () => { sensorEventCount++; };
      window.addEventListener('deviceorientation', sensorListener);
      window.addEventListener('devicemotion', sensorListener);
      setTimeout(() => {
        window.removeEventListener('deviceorientation', sensorListener);
        window.removeEventListener('devicemotion', sensorListener);
        res(sensorEventCount);
      }, 400);
    });
    r.xrInfo = {present: 'xr' in navigator};
    if (r.xrInfo.present && navigator.xr && navigator.xr.isSessionSupported) {
      try { r.xrInfo.immersiveVr = await navigator.xr.isSessionSupported('immersive-vr'); }
      catch (e) { r.xrInfo.immersiveVr = 'ERR'; }
      try { r.xrInfo.immersiveAr = await navigator.xr.isSessionSupported('immersive-ar'); }
      catch (e) { r.xrInfo.immersiveAr = 'ERR'; }
    }
    // vendorFlavors is NOT a Chromium API (verified in navigator_id.idl) -- it
    // is recorded, never asserted.
    r.miscPresence = {vendor: navigator.vendor, productSub: navigator.productSub,
      vendorSub: navigator.vendorSub, vendorFlavors: navigator.vendorFlavors,
      maxActions: (typeof Notification === 'function') ? Notification.maxActions : null,
      domBlockers: navigator.domBlockers == null ? null : navigator.domBlockers,
      serviceWorker: 'serviceWorker' in navigator,
      presentation: typeof navigator.presentation,
      broadcastChannel: typeof BroadcastChannel, imageCapture: typeof ImageCapture};
    r.sensorsMiscOk = Object.values(r.sensorTypes).every(t => t === 'function')
      && r.sensorEventsFired === 0
      && (!r.xrInfo.present
        || (r.xrInfo.immersiveVr === false && r.xrInfo.immersiveAr === false))
      && r.miscPresence.vendor === 'Google Inc.'
      && r.miscPresence.productSub === '20030107'
      && r.miscPresence.maxActions === 2
      && (r.miscPresence.domBlockers == null || r.miscPresence.domBlockers === 0)
      && r.miscPresence.serviceWorker === true
      && r.miscPresence.presentation === 'object'
      && r.miscPresence.broadcastChannel === 'function'
      && r.miscPresence.imageCapture === 'function';
  } catch (e) { r.sensorsMiscError = String(e); r.sensorsMiscOk = false; }

  // --- 42. WebAuthn capability matrix (detection-gaps row 25, shipped 133) ---
  // getClientCapabilities() must resolve to a boolean map whose keys are the
  // 9 spec values (or extension:* names); values are booleans.
  try {
    r.webAuthnCaps = null;
    if (r.webAuthnPresent && typeof PublicKeyCredential.getClientCapabilities === 'function') {
      r.webAuthnCaps = await PublicKeyCredential.getClientCapabilities();
    }
    // Chrome 157's real map carries 24 keys (verified live); the W3C enum
    // grew past the 9 the 133-era spec listed. Anything not in this set is a
    // lie; extension:* is always allowed.
    const knownCaps = new Set(['conditionalCreate', 'conditionalGet', 'hybridTransport',
      'passkeyPlatformAuthenticator', 'userVerifyingPlatformAuthenticator',
      'relatedOrigins', 'signalAllAcceptedCredentials', 'signalCurrentUserDetails',
      'signalUnknownCredential', 'immediateGet']);
    const capKeys = Object.keys(r.webAuthnCaps || {});
    r.webAuthnCapsOk = r.webAuthnCaps != null && capKeys.length > 0
      && capKeys.every(k => knownCaps.has(k) || k.startsWith('extension:'))
      && Object.values(r.webAuthnCaps).every(v => typeof v === 'boolean');
  } catch (e) { r.webAuthnCapsError = String(e); r.webAuthnCapsOk = false; }

  // --- 43. Wasm feature matrix (detection-gaps row 32) ---
  // Same V8 as Chrome 157 means every shipped feature validates; the minimal
  // probe modules are the canonical wasm-feature-detect 1.10.1 bytes.
  try {
    const wasmValid = wasmBytes => {
      try { return WebAssembly.validate(new Uint8Array(wasmBytes)); }
      catch (e) { return false; }
    };
    // threads requires crossOriginIsolated (COOP/COEP) for shared memory;
    // on a plain page the SAB constructor is gated, so record N/A (null) there
    // instead of throwing and killing the whole matrix.
    r.wasmFeatures = {
      simd: wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1,
        0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]),
      threads: (typeof SharedArrayBuffer !== 'undefined'
        ? wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3,
            1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11])
        : null),
      bulkMemory: wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
        5, 3, 1, 0, 1, 10, 14, 1, 12, 0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11]),
      exceptions: wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
        10, 8, 1, 6, 0, 6, 64, 25, 11, 11]),
      referenceTypes: wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1,
        0, 10, 7, 1, 5, 0, 208, 112, 26, 11]),
      relaxedSimd: wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2,
        1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]),
      gc: wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 95, 1, 120, 0]),
      memory64: wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]),
      tailCall: wasmValid([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0,
        10, 6, 1, 4, 0, 18, 0, 11]),
    };
    r.wasmFeaturesOk = Object.entries(r.wasmFeatures)
      .every(([k, v]) => v === true || (k === 'threads' && v == null));
  } catch (e) { r.wasmFeaturesError = String(e); r.wasmFeaturesOk = false; }


  return r;
}
"""


def _coherent_sec_fetch(sf: dict | None) -> bool:
    """The battery's TLS check is a top-level CDP navigation, so the coherent
    Sec-Fetch set is site=none (no initiator), mode=navigate, dest=document,
    user=?1 -- all four present."""
    if not isinstance(sf, dict):
        return False
    return (all(sf.get(k) is not None for k in ("site", "mode", "dest", "user"))
            and sf.get("mode") == "navigate" and sf.get("dest") == "document"
            and sf.get("site") == "none" and sf.get("user") == "?1")


# Each check: (key, human label, predicate on the probe dict).
_CHECKS = [
    ("webdriver", "navigator.webdriver is false",
     lambda p: p.get("webdriver") in (False, None)),
    ("uaHasHeadless", "UA has no 'HeadlessChrome'",
     lambda p: p.get("uaHasHeadless") is False),
    ("uaPlatformCoherent", "UA matches navigator.platform",
     lambda p: p.get("uaPlatformCoherent") is True),
    ("hasChromeObject", "window.chrome object present",
     lambda p: p.get("hasChromeObject") is True),
    ("pluginsLength", "navigator.plugins non-empty",
     lambda p: (p.get("pluginsLength") or 0) > 0),
    ("languagesOk", "navigator.languages non-empty array",
     lambda p: p.get("languagesOk") is True),
    ("webglOk", "WebGL works, renderer not SwiftShader",
     lambda p: p.get("webglOk") is True),
    ("canvasOk", "canvas renders (toDataURL non-blank)",
     lambda p: p.get("canvasOk") is True),
    ("cdpRuntimeLeak", "no CDP Runtime.enable leak",
     lambda p: p.get("cdpRuntimeLeak") is False),
    ("hardwareOk", "hardwareConcurrency plausible",
     lambda p: p.get("hardwareOk") is True),
    ("windowDimsOk", "window outer dimensions > 0",
     lambda p: p.get("windowDimsOk") is True),
    ("pwGlobals", "no __pw*/__playwright* globals",
     lambda p: (p.get("pwGlobals") or 0) == 0),
    ("nextHopOk", "navigation nextHopProtocol not empty (no doc re-serving)",
     lambda p: p.get("nextHopOk") is True),
    ("stackClean", "error stacks have no automation frames",
     lambda p: p.get("stackClean") is True),
    ("webrtcPublicIps", "WebRTC candidates reveal no IP beyond the HTTP egress",
     lambda p: set(p.get("webrtcPublicIps") or []) <= set(p.get("httpEgressIps") or [])),
    # --- extended surfaces (sections 15-35): WebGPU, Intl/ICU, fonts, timing,
    #     screen coherence, audio, codecs, permissions, device APIs, storage,
    #     runtime artifacts, EME/WebCodecs/WebAuthn, GPU/video pipelines ---
    ("webdriverType", "navigator.webdriver is a plain boolean (not string-masked)",
     lambda p: p.get("webdriverType") == "boolean"),
    ("platformUachOk", "navigator.platform matches the persona's UA-CH platform",
     lambda p: p.get("platformUachOk") is True),
    ("webgpuOk", "WebGPU present, requestAdapter callable, no SwiftShader in adapter info",
     lambda p: p.get("webgpuOk") is True),
    ("intlCollationOk", "sv collation sorts o-diaeresis after z, en does not",
     lambda p: p.get("intlCollationOk") is True),
    ("intlNumberingOk", "ar-EG number formatting differs from en (Arabic-Indic digits)",
     lambda p: p.get("intlNumberingOk") is True),
    ("intlPluralCyOk", "cy (Welsh) plural categories are the 6-way ICU set",
     lambda p: p.get("intlPluralCyOk") is True),
    ("intlSupportedValuesOk", "Intl.supportedValuesOf timezone/currency inventory is full",
     lambda p: p.get("intlSupportedValuesOk") is True),
    ("intlDisplayNamesOk", "Intl.DisplayNames typed ctors resolve region+language",
     lambda p: p.get("intlDisplayNamesOk") is True),
    ("fontsCoherent", "core persona-OS fonts measure as present",
     lambda p: p.get("fontsCoherent") is True),
    ("timingPrecisionOk", "performance.now precision not clamped or fully flat",
     lambda p: p.get("timingPrecisionOk") is True),
    ("timeOriginOk", "performance.timeOrigin+now tracks Date.now (<5s)",
     lambda p: p.get("timeOriginOk") is True),
    ("screenCoherent", "screen/avail/colorDepth/window cross-checks hold",
     lambda p: p.get("screenCoherent") is True),
    ("touchCoherent", "no touch points/handlers on a desktop persona",
     lambda p: p.get("touchCoherent") is True),
    ("audioSignatureOk", "OfflineAudioContext renders the full signature buffer",
     lambda p: p.get("audioSignatureOk") is True),
    ("audioLiveOk", "AudioContext present, 2-channel output, non-null baseLatency",
     lambda p: p.get("audioLiveOk") is True),
    ("codecMatrixOk", "H.264 + MSE codecs resolve as the claimed browser",
     lambda p: p.get("codecMatrixOk") is True),
    ("permissionsPrompt", "geolocation/notifications permissions are 'prompt'",
     lambda p: p.get("permissionsPrompt") is True),
    ("notificationDefault", "Notification.permission not pre-granted/denied",
     lambda p: p.get("notificationDefault") is True),
    ("standardPresenceOk", "standard APIs present, SAB gated by crossOriginIsolated",
     lambda p: p.get("standardPresenceOk") is True),
    ("deviceApiPresenceOk", "gamepads/USB/MIDI APIs present (desktop Chrome)",
     lambda p: p.get("deviceApiPresenceOk") is True),
    ("bluetoothOk", "navigator.bluetooth object with getAvailability",
     lambda p: p.get("bluetoothOk") is True),
    ("gamepadsOk", "getGamepads returns a real empty Array",
     lambda p: p.get("gamepadsOk") is True),
    ("mediaDevicesOk", "enumerateDevices returns real media devices",
     lambda p: p.get("mediaDevicesOk") is True),
    ("storageEstimateOk", "storage.estimate() reports a nonzero quota (value recorded)",
     lambda p: p.get("storageEstimateOk") is True),
    ("globalPollutionOk", "no automation-signature globals on window",
     lambda p: p.get("globalPollutionOk") is True),
    ("propertyDescriptorOk", "Navigator getters are still [native code]",
     lambda p: p.get("propertyDescriptorOk") is True),
    ("toStringIntegrityOk", "native method toString not replaced",
     lambda p: p.get("toStringIntegrityOk") is True),
    ("evalIntegrityOk", "window.eval still native and === eval",
     lambda p: p.get("evalIntegrityOk") is True),
    ("constructorNamesOk", "Navigator/Screen/Document/Permissions constructor names intact",
     lambda p: p.get("constructorNamesOk") is True),
    ("schedulingOk", "IdleDetector + scheduling.isInputPending present",
     lambda p: p.get("schedulingOk") is True),
    ("visibilityOk", "page reports visible/hidden=false/focus=true",
     lambda p: p.get("visibilityOk") is True),
    ("rafRunning", "requestAnimationFrame advances (rendering not frozen)",
     lambda p: p.get("rafRunning") is True),
    ("widevineL1Ok", "Widevine resolvable for a desktop persona (HW/L1 flags recorded)",
     lambda p: p.get("widevineL1Ok") is True),
    ("clearKeyOk", "org.w3.clearkey EME accessible",
     lambda p: p.get("clearKeyOk") is True),
    ("webCodecsDecodeOk", "VideoDecoder supports H.264 (HW flags recorded)",
     lambda p: p.get("webCodecsDecodeOk") is True),
    ("webAuthnOk", "WebAuthn PublicKeyCredential + credentials.create present",
     lambda p: p.get("webAuthnOk") is True),
    ("networkInfoOk", "navigator.connection present with numeric shape",
     lambda p: p.get("networkInfoOk") is True),
    ("speechVoicesOk", "speechSynthesis.getVoices() non-empty",
     lambda p: p.get("speechVoicesOk") is True),
    ("keyboardLayoutOk", "keyboard.getLayoutMap maps KeyW to 'w' (US QWERTY)",
     lambda p: p.get("keyboardLayoutOk") is True),
    ("highEntropyUaOk", "UA-CH high-entropy values resolve (Chromium brand presence allowed)",
     lambda p: p.get("highEntropyUaOk") is True),
    ("perfMemoryOk", "performance.memory heap limit plausible (>1GB)",
     lambda p: p.get("perfMemoryOk") is True),
    ("hvcAc3Ok", "MediaSource HEVC/AC-3 matrix queryable (booleans recorded)",
     lambda p: p.get("hvcAc3Ok") is True),
    ("newApiPresenceOk", "2025-era APIs present (viewTransition/mediaSession/clipboard/wakeLock)",
     lambda p: p.get("newApiPresenceOk") is True),
    ("gpuReadbackTimingOk", "canvas/WebGL readback timing distributions recorded",
     lambda p: p.get("gpuReadbackTimingOk") is True),
    ("mediaCapabilitiesOk", "mediaCapabilities.decodingInfo resolves (flags recorded)",
     lambda p: p.get("mediaCapabilitiesOk") is True),
    ("videoRoundtripOk", "vp8 encode->decode roundtrip completes 10/10 frames",
     lambda p: p.get("videoRoundtripOk") is True),
    ("playbackQualityOk", "video playback produces rVFC frames + valid quality stats",
     lambda p: p.get("playbackQualityOk") is True),
    # --- CDP/automation-leak + network-stack surface (sections 36-37) ---
    ("cdpEnumOk", "no automation-injected properties on window/navigator/document",
     lambda p: p.get("cdpEnumOk") is True),
    ("eventTrustOk", "synthetic events report isTrusted=false and the getter stays native",
     lambda p: p.get("eventTrustOk") is True),
    ("stackTracesOk", "error stack traces from multiple paths leak no automation frames",
     lambda p: p.get("stackTracesOk") is True),
    ("tlsSurfaceOk", "TLS fingerprint present, server-observed UA matches the browser",
     lambda p: p.get("tlsSurfaceOk") is True),
    ("tlsUaMismatch", "server-observed user_agent equals navigator.userAgent",
     lambda p: p.get("tlsUaMismatch") is False),
    ("tlsAcceptLanguageOk", "Accept-Language consistent with navigator.languages "
                            "(pass when no headers were observable)",
     lambda p: p.get("tlsAcceptLanguageOk") is True),
    # --- 2026-11-14 adversarial extension (detection-gaps rows 20/22/24/25/27/32) ---
    ("mediaQueriesOk", "CSS media queries coherent (scheme/forced/monochrome/gamut)",
     lambda p: p.get("mediaQueriesOk") is True),
    ("systemColorsOk", "CSS system colors all resolve; Windows ActiveText is the Win accent blue",
     lambda p: p.get("systemColorsOk") is True),
    ("intlTimezoneOk", "Intl resolvedOptions().timeZone is a real IANA zone "
                      "(the timezone_mismatch input) + formatToParts/collation sanity",
     lambda p: p.get("intlTimezoneOk") is True),
    ("webrtcDepthOk", "WebRTC getCapabilities/SDP/getStats coherent (codecs + cipher suites)",
     lambda p: p.get("webrtcDepthOk") is True),
    ("sensorsMiscOk", "sensor APIs present without events + misc presence set coherent (desktop)",
     lambda p: p.get("sensorsMiscOk") is True),
    ("webAuthnCapsOk", "WebAuthn getClientCapabilities resolves to a boolean map "
                      "over the 9 spec keys",
     lambda p: p.get("webAuthnCapsOk") is True),
    ("wasmFeaturesOk", "WebAssembly feature matrix validates (Chrome-157 feature set)",
     lambda p: p.get("wasmFeaturesOk") is True),
    ("tlsSecFetchOk", "Sec-Fetch-Site/Mode/Dest/User present and coherent with the "
                     "top-level navigation (pass when no headers were observable)",
     lambda p: (p.get("tlsSecFetchObserved") is False)
               or _coherent_sec_fetch(p.get("tlsSecFetch"))),
]


def score(probe: dict) -> dict:
    """Turn a raw probe dict into {passed, total, failures, results}."""
    results = []
    failures = []
    for key, label, predicate in _CHECKS:
        try:
            ok = bool(predicate(probe))
        except Exception:  # noqa: BLE001 - a throwing predicate is a failure
            ok = False
        results.append({"key": key, "label": label, "ok": ok,
                        "value": probe.get(key)})
        if not ok:
            failures.append(label)
    passed = sum(1 for r in results if r["ok"])
    return {
        "passed": passed,
        "total": len(_CHECKS),
        "failures": failures,
        "results": results,
    }


def format_report(name: str, scored: dict, extra: dict | None = None) -> str:
    lines = [f"\n=== {name} ===",
             f"  local checks: {scored['passed']}/{scored['total']}"]
    for r in scored["results"]:
        mark = "PASS" if r["ok"] else "FAIL"
        val = r["value"]
        val_s = "" if val is None else f"  ({val!r})"
        lines.append(f"  [{mark}] {r['label']}{val_s if not r['ok'] else ''}")
    if extra:
        for k, v in extra.items():
            lines.append(f"  {k}: {v}")
    return "\n".join(lines)
