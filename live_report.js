'use strict';

/* ── State ── */
const MAX_RECORDING_SECONDS = 60;
let currentPosition    = null;
let attachedFiles      = [];
let mediaStream        = null;
let mediaRecorder      = null;
let recordedChunks     = [];
let liveRecordingBlob  = null;
let recordingSeconds   = 0;
let recordingTimer     = null;
let miniMap            = null;
let miniMapMarker      = null;
let lrListenersAttached = false;

/* ── Theme (safe in both standalone and embedded contexts) ── */
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('dashboard-theme', next);
  const label = document.getElementById('themeModeLabel');
  if (label) label.textContent = next === 'light' ? 'Light' : 'Dark';
}

/* ── Modal open / close ── */
function openLiveReport() {
  const modal = document.getElementById('liveReportModal');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  attachLiveReportListeners();
  updateSubmitSummary();
  setTimeout(() => {
    if (miniMap) miniMap.invalidateSize();
    const prompt = document.getElementById('locationPrompt');
    if (!currentPosition && prompt && prompt.style.display !== 'none') {
      requestLocation();
    }
  }, 300);
}

function closeLiveReport() {
  const modal = document.getElementById('liveReportModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
  stopCamera();
}

function lrHandleBackdrop(event) {
  if (event.target === document.getElementById('liveReportModal')) {
    closeLiveReport();
  }
}

/* ── Location ── */
function requestLocation() {
  const pill = document.getElementById('locationStatusPill');
  const btn  = document.getElementById('locationBtn');

  if (!('geolocation' in navigator)) {
    pill.textContent = 'Not supported on this device';
    pill.className   = 'lr-status-pill lr-status-denied';
    return;
  }

  pill.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> Requesting…';
  pill.className = 'lr-status-pill lr-status-pending';
  if (btn) btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    onLocationGranted,
    onLocationError,
    { enableHighAccuracy: true, timeout: 14000, maximumAge: 0 }
  );
}

function onLocationGranted(position) {
  currentPosition = position;
  const { latitude: lat, longitude: lon, accuracy } = position.coords;

  const pill = document.getElementById('locationStatusPill');
  pill.innerHTML = '<i class="ti ti-circle-check"></i> Location shared';
  pill.className = 'lr-status-pill lr-status-granted';

  const btn = document.getElementById('locationBtn');
  if (btn) btn.disabled = false;

  document.getElementById('locationPrompt').style.display  = 'none';
  document.getElementById('locationGranted').style.display = 'block';

  document.getElementById('locationCoords').innerHTML =
    `<i class="ti ti-map-pin"></i>&nbsp;${lat.toFixed(5)}&deg;N,&nbsp;${lon.toFixed(5)}&deg;E &nbsp;&middot;&nbsp; &plusmn;${Math.round(accuracy)} m`;

  initMiniMap(lat, lon);
  updateSubmitSummary();
  markProgDone(1);
}

function onLocationError(error) {
  const pill = document.getElementById('locationStatusPill');
  pill.textContent = error.code === error.PERMISSION_DENIED ? 'Permission denied' : 'Could not get location';
  pill.className   = 'lr-status-pill lr-status-denied';
  const btn = document.getElementById('locationBtn');
  if (btn) btn.disabled = false;
}

function skipLocation() {
  document.getElementById('locationPrompt').style.display = 'none';
  const pill = document.getElementById('locationStatusPill');
  pill.innerHTML = '<i class="ti ti-map-pin-off"></i> Skipped';
  pill.className = 'lr-status-pill';
  markProgDone(1);
}

/* ── Leaflet mini-map ── */
function initMiniMap(lat, lon) {
  if (miniMap) {
    miniMapMarker.setLatLng([lat, lon]);
    miniMap.setView([lat, lon], 14);
    miniMap.invalidateSize();
    return;
  }
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const tile = dark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

  miniMap = L.map('locationMiniMap', { zoomControl: true, attributionControl: false }).setView([lat, lon], 14);
  L.tileLayer(tile, { maxZoom: 19 }).addTo(miniMap);

  const icon = L.divIcon({
    className: '',
    html: '<div style="width:16px;height:16px;background:#f85149;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 3px rgba(248,81,73,.4)"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  miniMapMarker = L.marker([lat, lon], { icon }).addTo(miniMap);
}

/* ── Category & Severity ── */
function selectCategory(btn) {
  document.querySelectorAll('.lr2-cat').forEach(b => b.classList.remove('lr2-cat-active'));
  btn.classList.add('lr2-cat-active');
  document.getElementById('categorySelect').value = btn.dataset.value;
}

function selectSeverity(btn) {
  document.querySelectorAll('.lr2-sev').forEach(b => b.classList.remove('lr2-sev-active'));
  btn.classList.add('lr2-sev-active');
  document.getElementById('severitySelect').value = btn.dataset.value;
}

/* ── Quick tags ── */
function appendTag(tag) {
  const ta  = document.getElementById('reportMessage');
  const val = ta.value.trim();
  ta.value  = val ? val + ', ' + tag : tag;
  document.getElementById('messageCharCount').textContent = String(ta.value.length);
  ta.focus();
}

/* ── File handling & drag-drop ── */
function handleFiles(files) {
  attachedFiles = attachedFiles.concat(Array.from(files));
  renderMediaGrid();
  updateSubmitSummary();
}

function renderMediaGrid() {
  const grid = document.getElementById('uploadAttachmentList');
  grid.innerHTML = '';
  attachedFiles.forEach((file, index) => {
    const isImage = file.type.startsWith('image/');
    const url     = URL.createObjectURL(file);
    const item    = document.createElement('div');
    item.className = 'lr2-media-item';
    item.innerHTML = `
      ${isImage
        ? `<img src="${url}" alt="${escapeHtml(file.name)}">`
        : `<video src="${url}" muted></video>`}
      <button type="button" class="lr2-media-remove" data-index="${index}" title="Remove">
        <i class="ti ti-x"></i>
      </button>
      <div class="lr2-media-label">${escapeHtml(file.name)}</div>
    `;
    grid.appendChild(item);
  });
  grid.querySelectorAll('.lr2-media-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      attachedFiles.splice(Number(btn.dataset.index), 1);
      renderMediaGrid();
      updateSubmitSummary();
    });
  });
}

function initDropZone() {
  const zone = document.getElementById('dropZone');
  if (!zone) return;
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragging');
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragging');
    handleFiles(e.dataTransfer.files);
  });
}

/* ── Camera & recording ── */
function setCameraState(state) {
  const map = { idle: 0, ready: 1, recording: 2, recorded: 3 };
  const ids = ['cameraControlsIdle', 'cameraControlsReady', 'cameraControlsRecording', 'cameraControlsRecorded'];
  ids.forEach((id, i) => {
    document.getElementById(id).style.display = i === map[state] ? 'flex' : 'none';
  });
  document.getElementById('cameraFrame').style.display     = state === 'idle' ? 'none' : 'block';
  document.getElementById('recBadge').style.display        = state === 'recording' ? 'flex' : 'none';
  document.getElementById('recProgressWrap').style.display = state === 'recording' ? 'block' : 'none';
}

async function startCamera() {
  const errBox = document.getElementById('cameraError');
  errBox.style.display = 'none';
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
  } catch {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      errBox.textContent   = `Camera unavailable: ${err.message}`;
      errBox.style.display = 'block';
      return;
    }
  }
  document.getElementById('livePreview').srcObject = mediaStream;
  setCameraState('ready');
}

function pickMimeType() {
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function startRecording() {
  if (!mediaStream) return;
  recordedChunks = [];
  const mimeType = pickMimeType();
  mediaRecorder  = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop          = handleRecordingDone;
  mediaRecorder.start();
  recordingSeconds = 0;
  updateRecTimer();
  setCameraState('recording');
  recordingTimer = setInterval(() => {
    recordingSeconds += 1;
    updateRecTimer();
    const bar = document.getElementById('recProgressBar');
    if (bar) bar.style.width = ((recordingSeconds / MAX_RECORDING_SECONDS) * 100) + '%';
    if (recordingSeconds >= MAX_RECORDING_SECONDS) stopRecording();
  }, 1000);
}

function updateRecTimer() {
  const m = Math.floor(recordingSeconds / 60);
  const s = recordingSeconds % 60;
  document.getElementById('recTimer').textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function stopRecording() {
  clearInterval(recordingTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

function handleRecordingDone() {
  liveRecordingBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
  stopTracks();
  setCameraState('recorded');
  updateSubmitSummary();
}

function discardLiveClip() {
  liveRecordingBlob = null;
  setCameraState('idle');
  updateSubmitSummary();
}

function stopCamera() {
  stopTracks();
  setCameraState('idle');
}

function stopTracks() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
}

/* ── Submit summary ── */
function updateSubmitSummary() {
  const ssLoc   = document.getElementById('ss-location');
  const ssFiles = document.getElementById('ss-files');
  const ssClip  = document.getElementById('ss-clip');
  if (!ssLoc) return;

  if (currentPosition) {
    const { latitude: lat, longitude: lon } = currentPosition.coords;
    ssLoc.innerHTML = `<i class="ti ti-map-pin"></i> ${lat.toFixed(4)}&deg;N, ${lon.toFixed(4)}&deg;E`;
    ssLoc.className = 'lr2-ss-item granted';
  } else {
    ssLoc.innerHTML = `<i class="ti ti-map-pin-off"></i> Location not shared`;
    ssLoc.className = 'lr2-ss-item';
  }

  if (attachedFiles.length > 0) {
    const imgs  = attachedFiles.filter(f => f.type.startsWith('image/')).length;
    const vids  = attachedFiles.filter(f => f.type.startsWith('video/')).length;
    const parts = [];
    if (imgs) parts.push(`${imgs} photo${imgs > 1 ? 's' : ''}`);
    if (vids) parts.push(`${vids} video${vids > 1 ? 's' : ''}`);
    ssFiles.innerHTML = `<i class="ti ti-paperclip"></i> ${attachedFiles.length} file${attachedFiles.length > 1 ? 's' : ''} (${parts.join(', ')})`;
    ssFiles.className = 'lr2-ss-item has-files';
  } else {
    ssFiles.innerHTML = `<i class="ti ti-paperclip"></i> No files attached`;
    ssFiles.className = 'lr2-ss-item';
  }

  if (ssClip) ssClip.style.display = liveRecordingBlob ? 'flex' : 'none';
}

/* ── Progress tracker ── */
function markProgDone(step) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`prog${i}`);
    if (!el) continue;
    el.classList.toggle('done',   i < step);
    el.classList.toggle('active', i === step);
    if (i > step) el.classList.remove('done', 'active');
  }
  for (let i = 1; i <= 3; i++) {
    const line = document.getElementById(`pline${i}${i + 1}`);
    if (line) line.classList.toggle('done', i < step);
  }
}

/* ── Result display ── */
function showResult(kind, html) {
  const panel = document.getElementById('resultPanel');
  panel.className     = `lr-result-panel lr-result-${kind}`;
  panel.innerHTML     = html;
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ── Form submit ── */
async function submitReport(event) {
  event.preventDefault();

  const message = document.getElementById('reportMessage').value.trim();
  if (!message) {
    showResult('error', '<i class="ti ti-alert-triangle"></i> Please describe what is happening before submitting.');
    document.getElementById('reportMessage').focus();
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled  = true;
  btn.innerHTML = '<i class="ti ti-loader-2 ti-spin"></i> Submitting…';

  const form = new FormData();
  form.append('message',        message);
  form.append('category',       document.getElementById('categorySelect').value);
  form.append('severity',       document.getElementById('severitySelect').value);
  form.append('locationShared', currentPosition ? 'true' : 'false');
  if (currentPosition) {
    form.append('lat',      currentPosition.coords.latitude);
    form.append('lon',      currentPosition.coords.longitude);
    form.append('accuracy', currentPosition.coords.accuracy);
  }
  attachedFiles.forEach(file => form.append('media', file, file.name));
  if (liveRecordingBlob) {
    form.append('media', liveRecordingBlob, `live-clip-${Date.now()}.webm`);
  }

  try {
    const res  = await fetch('/api/submit-report', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `Server error (${res.status})`);

    showResult('success',
      `<i class="ti ti-circle-check"></i> Report received &mdash; ` +
      `Reference ID: <strong>${escapeHtml(data.reportId)}</strong><br>` +
      `<small style="opacity:.75;display:block;margin-top:4px">Thank you. Your report has been logged and will be reviewed by security analysts.</small>`
    );
    markProgDone(4);
    resetForm();
  } catch (err) {
    showResult('error',
      `<i class="ti ti-alert-triangle"></i> Submission failed: ${escapeHtml(err.message)}`
    );
  } finally {
    btn.disabled  = false;
    btn.innerHTML = '<i class="ti ti-send"></i> Submit Report';
  }
}

function resetForm() {
  currentPosition   = null;
  attachedFiles     = [];
  liveRecordingBlob = null;

  document.getElementById('reportForm').reset();
  document.getElementById('categorySelect').value = 'Other';
  document.getElementById('severitySelect').value = 'Medium';
  document.getElementById('messageCharCount').textContent = '0';

  document.querySelectorAll('.lr2-cat').forEach(b => b.classList.remove('lr2-cat-active'));
  const otherBtn = document.querySelector('.lr2-cat[data-value="Other"]');
  if (otherBtn) otherBtn.classList.add('lr2-cat-active');

  document.querySelectorAll('.lr2-sev').forEach(b => b.classList.remove('lr2-sev-active'));
  const medBtn = document.querySelector('.lr2-sev[data-value="Medium"]');
  if (medBtn) medBtn.classList.add('lr2-sev-active');

  renderMediaGrid();
  discardLiveClip();
  stopCamera();

  const prompt  = document.getElementById('locationPrompt');
  const granted = document.getElementById('locationGranted');
  if (prompt)  prompt.style.display  = '';
  if (granted) granted.style.display = 'none';
  const pill = document.getElementById('locationStatusPill');
  if (pill) { pill.textContent = 'Not shared'; pill.className = 'lr-status-pill'; }

  updateSubmitSummary();
}

/* ── Utility ── */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/* ── Attach event listeners (idempotent) ── */
function attachLiveReportListeners() {
  if (lrListenersAttached) return;
  lrListenersAttached = true;

  const mediaInput = document.getElementById('mediaInput');
  if (mediaInput) {
    mediaInput.addEventListener('change', e => {
      handleFiles(e.target.files);
      e.target.value = '';
    });
  }

  const ta = document.getElementById('reportMessage');
  if (ta) {
    ta.addEventListener('input', e => {
      document.getElementById('messageCharCount').textContent = String(e.target.value.length);
    });
  }

  const form = document.getElementById('reportForm');
  if (form) form.addEventListener('submit', submitReport);

  initDropZone();

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLiveReport();
  });
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  const theme = localStorage.getItem('dashboard-theme') || 'dark';
  const label = document.getElementById('themeModeLabel');
  if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';

  // Standalone mode: no modal wrapper in the page (live_report.html)
  if (!document.getElementById('liveReportModal')) {
    document.documentElement.style.height    = 'auto';
    document.documentElement.style.overflowY = 'auto';
    document.documentElement.style.overflowX = 'hidden';
    attachLiveReportListeners();
    updateSubmitSummary();
    setTimeout(requestLocation, 900);
  }
});
