/* =========================================================
   RPD EQUESTRIAN — Barn schedule, horse & student tracking app
   Static, client-side only. Talks directly to Google Calendar
   & Google Drive APIs using the signed-in user's OAuth token.
   ========================================================= */

/* ---------------- CONFIG ---------------- */
const CONFIG = {
  CLIENT_ID: "288317276128-d94db2aofp0it4glcsscbm4jaq7go01j.apps.googleusercontent.com",
  CALENDAR_ID: "8920f5279f3d5f19d97bb40abcf840dcbec4f15c8e1467a2be6b0b61734f2d6f@group.calendar.google.com",
  CALENDAR_EMBED_SRC: "https://calendar.google.com/calendar/embed?src=8920f5279f3d5f19d97bb40abcf840dcbec4f15c8e1467a2be6b0b61734f2d6f%40group.calendar.google.com&ctz=America%2FNew_York",
  SCOPES: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.send",
  MAX_ATTACHMENT_BYTES: 20 * 1024 * 1024,
  APP_FOLDER_NAME: "RPD Equestrian Data",
  MEDIA_FOLDER_NAME: "Media",
  PROFILES_FOLDER_NAME: "Profiles",
  DB_FILE_NAME: "database.json",
  TIMEZONE: "America/New_York",
};

/* ---------------- STATE ---------------- */
const state = {
  accessToken: null,
  tokenExpiresAt: 0,
  tokenClient: null,
  refreshTimer: null,
  appFolderId: null,
  mediaFolderId: null,
  profilesFolderId: null,
  dbFileId: null,
  db: { horses: [], reportCards: [], students: [], lessonLogs: [], owners: [], billing: { defaultRate: 50, feeCatalog: [] }, invoices: [] },
  currentView: "schedule",
  currentHorseId: null,
  currentStudentId: null,
  currentOwnerId: null,
  currentAccountOwnerId: null,
  editingReportCardId: null,
  editingLessonLogId: null,
  editingSessionEventId: null,
  editingLessonEventId: null,
  horseFilter: "active",
  studentFilter: "active",
  scheduleDate: null, // set once utils are defined
  _billableEventsCache: null,
  _pendingLineItems: [],
  _ownerModalContext: null,
};

/* ---------------- UTIL ---------------- */
function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function showToast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => (t.hidden = true), 3500);
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---- Timezone-safe date helpers (always pinned to the barn's timezone,
   regardless of what timezone the viewing device happens to be set to) ---- */
function nyParts(d) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  return map;
}

function todayStr() {
  const p = nyParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

function nyDateStringFromISO(iso) {
  const p = nyParts(new Date(iso));
  return `${p.year}-${p.month}-${p.day}`;
}

function fmtDateHuman(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtDateShort(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtTimeHuman(iso) {
  return new Intl.DateTimeFormat(undefined, { timeZone: CONFIG.TIMEZONE, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function nyTimeStringFromISO(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  return `${map.hour}:${map.minute}`;
}

function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayIndexOf(dateStr) {
  return new Date(dateStr + "T12:00:00Z").getUTCDay(); // 0=Sun..6=Sat
}

function addOneHourToTime(timeStr, dateStr) {
  let [h, m] = timeStr.split(":").map(Number);
  h += 1;
  let outDate = dateStr;
  if (h >= 24) {
    h -= 24;
    outDate = addDaysToDateStr(dateStr, 1);
  }
  return { time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, date: outDate };
}

state.scheduleDate = todayStr();

/* ---------------- VIEW SWITCHING ---------------- */
function showOnly(id) {
  [
    "signedOutView", "loadingView", "errorView",
    "scheduleView", "horsesView", "horseProfileView",
    "studentsView", "studentProfileView",
    "accountsView", "accountProfileView",
  ].forEach((v) => {
    $("#" + v).hidden = v !== id;
  });
}

function setLoading(msg) {
  $("#loadingText").textContent = msg || "Loading…";
  showOnly("loadingView");
}

function setError(msg, retryFn) {
  $("#errorText").textContent = msg;
  const btn = $("#errorRetryBtn");
  btn.onclick = retryFn || (() => location.reload());
  showOnly("errorView");
}

/* =========================================================
   AUTH — sign in once, stay signed in across visits as long as
   the browser still has an active Google session (silent refresh).
   ========================================================= */
function initAuth() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: handleTokenResponse,
  });

  $("#signInBtn").addEventListener("click", () => requestSignIn(true));
  $("#signInBtn2").addEventListener("click", () => requestSignIn(true));
  $("#signOutBtn").addEventListener("click", signOut);

  attemptAutoSignIn();
}

function handleTokenResponse(resp) {
  if (resp.error) {
    if (!state.accessToken) showOnly("signedOutView");
    return;
  }
  state.accessToken = resp.access_token;
  state.tokenExpiresAt = Date.now() + (resp.expires_in || 3500) * 1000;
  sessionStorage.setItem("rpd_token", state.accessToken);
  sessionStorage.setItem("rpd_token_exp", String(state.tokenExpiresAt));
  localStorage.setItem("rpd_has_signed_in", "1");
  scheduleTokenRefresh();
  onSignedIn();
}

function attemptAutoSignIn() {
  const savedToken = sessionStorage.getItem("rpd_token");
  const savedExp = Number(sessionStorage.getItem("rpd_token_exp") || 0);
  if (savedToken && savedExp > Date.now() + 60000) {
    state.accessToken = savedToken;
    state.tokenExpiresAt = savedExp;
    scheduleTokenRefresh();
    onSignedIn();
    return;
  }
  if (localStorage.getItem("rpd_has_signed_in")) {
    setLoading("Signing you back in…");
    state.tokenClient.requestAccessToken({ prompt: "" });
  } else {
    showOnly("signedOutView");
  }
}

function requestSignIn(interactive) {
  state.tokenClient.requestAccessToken({ prompt: interactive ? "consent" : "" });
}

function scheduleTokenRefresh() {
  clearTimeout(state.refreshTimer);
  const msUntilRefresh = Math.max(state.tokenExpiresAt - Date.now() - 5 * 60 * 1000, 30000);
  state.refreshTimer = setTimeout(() => {
    state.tokenClient.requestAccessToken({ prompt: "" });
  }, msUntilRefresh);
}

function trySilentRefresh() {
  return new Promise((resolve) => {
    if (!state.tokenClient) { resolve(false); return; }
    state.tokenClient.requestAccessToken({
      prompt: "",
      callback: (resp) => {
        if (resp.error) { resolve(false); return; }
        state.accessToken = resp.access_token;
        state.tokenExpiresAt = Date.now() + (resp.expires_in || 3500) * 1000;
        sessionStorage.setItem("rpd_token", state.accessToken);
        sessionStorage.setItem("rpd_token_exp", String(state.tokenExpiresAt));
        scheduleTokenRefresh();
        resolve(true);
      },
    });
  });
}

function signOut() {
  if (state.accessToken) {
    google.accounts.oauth2.revoke(state.accessToken, () => {});
  }
  sessionStorage.removeItem("rpd_token");
  sessionStorage.removeItem("rpd_token_exp");
  localStorage.removeItem("rpd_has_signed_in");
  clearTimeout(state.refreshTimer);
  state.accessToken = null;
  $("#mainNav").hidden = true;
  $("#userChip").hidden = true;
  $("#signInBtn").hidden = false;
  $("#signOutBtn").hidden = true;
  showOnly("signedOutView");
}

async function onSignedIn() {
  $("#signInBtn").hidden = true;
  $("#signOutBtn").hidden = false;
  $("#mainNav").hidden = false;
  $("#userChip").hidden = false;
  $("#userChip").textContent = "Signed in";
  await bootstrapData();
}

/* =========================================================
   GOOGLE API HELPERS (fetch-based, no client library needed)
   ========================================================= */
async function apiFetch(url, options = {}, retried = false) {
  if (!state.accessToken) throw new Error("Not signed in");
  const headers = Object.assign({}, options.headers, {
    Authorization: "Bearer " + state.accessToken,
  });
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    if (!retried) {
      const refreshed = await trySilentRefresh();
      if (refreshed) return apiFetch(url, options, true);
    }
    throw new Error("Your Google session expired. Please sign in again.");
  }
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()); } catch (e) {}
    throw new Error(`Request failed (${res.status}): ${detail}`);
  }
  return res;
}

/* ---- Drive ---- */
async function driveFindOne(query) {
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)&spaces=drive`;
  const res = await apiFetch(url);
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveCreateFolder(name, parentId) {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder",
  };
  if (parentId) metadata.parents = [parentId];
  const res = await apiFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  return res.json();
}

async function driveFindOrCreateFolder(name, parentId) {
  const parentClause = parentId ? ` and '${parentId}' in parents` : "";
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false${parentClause}`;
  const existing = await driveFindOne(q);
  if (existing) return existing;
  return driveCreateFolder(name, parentId);
}

async function driveCreateJsonFile(name, parentId, contentObj) {
  const boundary = "rpdboundary" + Date.now();
  const metadata = { name, parents: [parentId], mimeType: "application/json" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(contentObj)}\r\n` +
    `--${boundary}--`;
  const res = await apiFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  return res.json();
}

async function driveGetJson(fileId) {
  const res = await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return res.json();
}

async function driveUpdateJson(fileId, contentObj) {
  await apiFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(contentObj),
  });
}

async function driveUploadMedia(file, parentId) {
  const boundary = "rpdboundary" + Date.now() + Math.random().toString(16).slice(2);
  const metadata = { name: file.name, parents: [parentId] };
  const metaPart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`;
  const endPart = `\r\n--${boundary}--`;

  const fileBuffer = await file.arrayBuffer();
  const encoder = new TextEncoder();
  const metaBytes = encoder.encode(metaPart);
  const endBytes = encoder.encode(endPart);
  const full = new Uint8Array(metaBytes.length + fileBuffer.byteLength + endBytes.length);
  full.set(metaBytes, 0);
  full.set(new Uint8Array(fileBuffer), metaBytes.length);
  full.set(endBytes, metaBytes.length + fileBuffer.byteLength);

  const res = await apiFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink,thumbnailLink",
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: full,
    }
  );
  const created = await res.json();

  try {
    await apiFetch(`https://www.googleapis.com/drive/v3/files/${created.id}/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
  } catch (e) {
    console.warn("Could not set public permission on media file", e);
  }
  return created;
}

/* ---- Calendar ---- */
async function calendarListEvents(timeMinISO, timeMaxISO, extraParams) {
  let url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.CALENDAR_ID)}/events` +
    `?timeMin=${encodeURIComponent(timeMinISO)}&timeMax=${encodeURIComponent(timeMaxISO)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=250`;
  if (extraParams && extraParams.privateExtendedProperty) {
    url += `&privateExtendedProperty=${encodeURIComponent(extraParams.privateExtendedProperty)}`;
  }
  const res = await apiFetch(url);
  const data = await res.json();
  return data.items || [];
}

async function calendarCreateEvent(evt) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.CALENDAR_ID)}/events`;
  const res = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(evt),
  });
  return res.json();
}

async function calendarDeleteEvent(eventId) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.CALENDAR_ID)}/events/${eventId}`;
  await apiFetch(url, { method: "DELETE" });
}

async function calendarPatchEvent(eventId, patchBody) {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.CALENDAR_ID)}/events/${eventId}`;
  const res = await apiFetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patchBody),
  });
  return res.json();
}

/* ---- Gmail (real email sending with attachments) ---- */
async function driveDownloadFile(fileId) {
  const res = await apiFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return res.arrayBuffer();
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

function arrayBufferToBase64(buffer) {
  return bytesToBase64(new Uint8Array(buffer));
}

function base64UrlFromString(str) {
  return bytesToBase64(new TextEncoder().encode(str))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeMimeSubject(subject) {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
}

function buildMimeMessage({ to, subject, bodyText, attachments }) {
  const boundary = "rpdmail" + Date.now() + Math.random().toString(16).slice(2);
  let msg = "";
  msg += `To: ${to}\r\n`;
  msg += `Subject: ${encodeMimeSubject(subject)}\r\n`;
  msg += `MIME-Version: 1.0\r\n`;
  msg += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
  msg += `--${boundary}\r\n`;
  msg += `Content-Type: text/plain; charset="UTF-8"\r\n\r\n`;
  msg += `${bodyText}\r\n\r\n`;
  (attachments || []).forEach((att) => {
    msg += `--${boundary}\r\n`;
    msg += `Content-Type: ${att.mimeType || "application/octet-stream"}; name="${att.filename}"\r\n`;
    msg += `Content-Disposition: attachment; filename="${att.filename}"\r\n`;
    msg += `Content-Transfer-Encoding: base64\r\n\r\n`;
    msg += `${att.base64Data}\r\n\r\n`;
  });
  msg += `--${boundary}--`;
  return msg;
}

async function gmailSendEmail({ to, subject, bodyText, attachments }) {
  const raw = base64UrlFromString(buildMimeMessage({ to, subject, bodyText, attachments }));
  const res = await apiFetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  return res.json();
}

/* ---- Invoice PDFs (jsPDF, loaded via CDN in index.html) ---- */
function buildInvoicePdfDoc(invoice, owner) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const info = accountContactInfo(owner);
  const left = 40;
  const right = 555;
  let y = 54;

  doc.setFontSize(18);
  doc.setFont(undefined, "bold");
  doc.text("RPD Equestrian", left, y);
  doc.setFont(undefined, "normal");
  doc.setFontSize(11);
  doc.text("Invoice", right, y, { align: "right" });

  y += 28;
  doc.setFontSize(10);
  doc.text("Invoice date: " + fmtDateHuman(invoice.date), left, y);
  doc.text("Status: " + (invoice.paid ? "PAID" : "UNPAID"), right, y, { align: "right" });

  y += 22;
  doc.setFont(undefined, "bold");
  doc.text("Bill to", left, y);
  doc.setFont(undefined, "normal");
  y += 14;
  doc.text(info.name || "", left, y);
  if (info.email) { y += 14; doc.text(info.email, left, y); }
  if (info.phone) { y += 14; doc.text(info.phone, left, y); }

  y += 26;
  doc.setFont(undefined, "bold");
  doc.text("Description", left, y);
  doc.text("Date", 380, y);
  doc.text("Amount", right, y, { align: "right" });
  doc.setFont(undefined, "normal");
  y += 6;
  doc.setLineWidth(0.5);
  doc.line(left, y, right, y);
  y += 16;

  (invoice.lineItems || []).forEach((li) => {
    if (y > 720) { doc.addPage(); y = 54; }
    doc.text(String(li.label || ""), left, y);
    if (li.date) doc.text(fmtDateShort(li.date), 380, y);
    doc.text("$" + Number(li.amount).toFixed(2), right, y, { align: "right" });
    y += 18;
  });

  y += 8;
  doc.line(left, y, right, y);
  y += 22;
  doc.setFont(undefined, "bold");
  doc.setFontSize(12);
  doc.text("Total: $" + Number(invoice.total).toFixed(2), right, y, { align: "right" });

  return doc;
}

function invoicePdfFilename(invoice, owner) {
  const name = accountContactInfo(owner).name.replace(/[^\w]+/g, "_");
  return `Invoice-${name}-${invoice.date}.pdf`;
}

function downloadInvoicePdf(invoice, owner) {
  if (!window.jspdf) { showToast("PDF library didn't load — check your connection and reload the page.", true); return; }
  const doc = buildInvoicePdfDoc(invoice, owner);
  doc.save(invoicePdfFilename(invoice, owner));
}

async function emailInvoicePdf(invoice, owner, btn) {
  if (!window.jspdf) { showToast("PDF library didn't load — check your connection and reload the page.", true); return; }
  const info = accountContactInfo(owner);
  if (!info.email) { showToast("No email on file for this account.", true); return; }
  const origText = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

  const doc = buildInvoicePdfDoc(invoice, owner);
  const filename = invoicePdfFilename(invoice, owner);
  const subject = `Invoice from RPD Equestrian — ${fmtDateHuman(invoice.date)}`;
  const bodyText = `Hi ${info.name},\n\nPlease find attached your invoice dated ${fmtDateHuman(invoice.date)} for $${Number(invoice.total).toFixed(2)}.\n\nStatus: ${invoice.paid ? "Paid" : "Unpaid"}\n\n— RPD Equestrian`;

  try {
    const base64Data = doc.output("datauristring").split(",")[1];
    await gmailSendEmail({
      to: info.email,
      subject,
      bodyText,
      attachments: [{ filename, mimeType: "application/pdf", base64Data }],
    });
    showToast("Invoice emailed.");
  } catch (err) {
    console.warn("Gmail send failed for invoice, falling back", err);
    if (/insufficient|scope|permission|403/i.test(err.message || "")) {
      showToast("Need permission to send email with attachments — please re-authorize, then try again.", true);
      requestSignIn(true);
    } else {
      showToast("Couldn't send automatically — downloading the PDF so you can attach it manually.", true);
    }
    doc.save(filename);
    window.location.href = `mailto:${encodeURIComponent(info.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyText + "\n\n(Attach the downloaded invoice PDF before sending.)")}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText || "Email Invoice"; }
  }
}

// Downloads each media item from Drive and base64-encodes it for attaching.
// Items over CONFIG.MAX_ATTACHMENT_BYTES or that fail to download are returned
// in `unattached` so callers can fall back to linking them instead.
async function prepareEmailAttachments(mediaList) {
  const attachments = [];
  const unattached = [];
  for (const m of mediaList || []) {
    if (!m.fileId) { unattached.push(m); continue; }
    try {
      const metaRes = await apiFetch(
        `https://www.googleapis.com/drive/v3/files/${m.fileId}?fields=size,mimeType,name`
      );
      const meta = await metaRes.json();
      const size = Number(meta.size || 0);
      if (size && size > CONFIG.MAX_ATTACHMENT_BYTES) { unattached.push(m); continue; }
      const buffer = await driveDownloadFile(m.fileId);
      attachments.push({
        filename: meta.name || m.name || "attachment",
        mimeType: meta.mimeType || m.mimeType || "application/octet-stream",
        base64Data: arrayBufferToBase64(buffer),
      });
    } catch (err) {
      console.warn("Could not attach file", m, err);
      unattached.push(m);
    }
  }
  return { attachments, unattached };
}

/* =========================================================
   BOOTSTRAP — find/create Drive folders + database.json
   ========================================================= */
async function bootstrapData() {
  setLoading("Connecting to Google Drive…");
  try {
    const appFolder = await driveFindOrCreateFolder(CONFIG.APP_FOLDER_NAME, null);
    state.appFolderId = appFolder.id;

    const mediaFolder = await driveFindOrCreateFolder(CONFIG.MEDIA_FOLDER_NAME, state.appFolderId);
    state.mediaFolderId = mediaFolder.id;

    const profilesFolder = await driveFindOrCreateFolder(CONFIG.PROFILES_FOLDER_NAME, state.appFolderId);
    state.profilesFolderId = profilesFolder.id;

    const q = `name='${CONFIG.DB_FILE_NAME}' and '${state.appFolderId}' in parents and trashed=false`;
    let dbFile = await driveFindOne(q);
    if (!dbFile) {
      dbFile = await driveCreateJsonFile(CONFIG.DB_FILE_NAME, state.appFolderId, { horses: [], reportCards: [], students: [], lessonLogs: [], owners: [], billing: { defaultRate: 50, feeCatalog: [] }, invoices: [] });
    }
    state.dbFileId = dbFile.id;

    setLoading("Loading horses & students…");
    state.db = await driveGetJson(state.dbFileId);
    if (!state.db.horses) state.db.horses = [];
    if (!state.db.reportCards) state.db.reportCards = [];
    if (!state.db.students) state.db.students = [];
    if (!state.db.lessonLogs) state.db.lessonLogs = [];
    if (!state.db.owners) state.db.owners = [];
    if (!state.db.billing) state.db.billing = { defaultRate: 50, feeCatalog: [] };
    if (state.db.billing.defaultRate == null) state.db.billing.defaultRate = 50;
    if (!state.db.billing.feeCatalog) state.db.billing.feeCatalog = [];
    if (!state.db.invoices) state.db.invoices = [];

    const migratedOwners = migrateOwnersFromHorses();
    if (migratedOwners) await saveDb();

    $("#calendarEmbed").src = CONFIG.CALENDAR_EMBED_SRC;

    navigate("schedule");
  } catch (err) {
    console.error(err);
    setError(err.message || "Could not load data from Google Drive.", bootstrapData);
  }
}

async function saveDb() {
  await driveUpdateJson(state.dbFileId, state.db);
}

/* ---- Owners: one-time migration of legacy per-horse owner fields ----
   Older horse records stored ownerName/ownerEmail/ownerPhone directly on
   the horse. This groups those into proper Owner records (deduped by
   email, falling back to name) and links each horse via horse.ownerId,
   so a single owner can have multiple horses linked to their account. */
function migrateOwnersFromHorses() {
  let changed = false;
  state.db.horses.forEach((h) => {
    if (h.ownerId) return;
    if (!h.ownerName && !h.ownerEmail && !h.ownerPhone) return;
    const emailKey = (h.ownerEmail || "").trim().toLowerCase();
    const nameKey = (h.ownerName || "").trim().toLowerCase();
    let owner = null;
    if (emailKey) {
      owner = state.db.owners.find((o) => (o.email || "").trim().toLowerCase() === emailKey);
    }
    if (!owner && nameKey) {
      owner = state.db.owners.find((o) => !o.email && (o.name || "").trim().toLowerCase() === nameKey);
    }
    if (!owner) {
      owner = {
        id: uuid(),
        name: h.ownerName || h.ownerEmail || h.ownerPhone || "Unnamed Owner",
        email: h.ownerEmail || "",
        phone: h.ownerPhone || "",
        rate: null,
        notes: "",
        createdAt: new Date().toISOString(),
      };
      state.db.owners.push(owner);
    }
    h.ownerId = owner.id;
    changed = true;
  });
  return changed;
}

function ownerForHorse(horse) {
  return horse && horse.ownerId ? state.db.owners.find((o) => o.id === horse.ownerId) || null : null;
}

// Not every owner is a student, but some are (e.g. a rider who owns their
// own horse) — this links an Owner record to that person's Student record
// so billing/contact info can be shared instead of duplicated.
function ownerForStudent(studentId) {
  return state.db.owners.find((o) => o.studentId === studentId) || null;
}

// Single source of truth for what to *display* for an owner account. If the
// owner is linked to a student, the student's name always wins (so renaming
// a student — e.g. adding a last name — instantly shows up everywhere the
// account is displayed, without needing to separately edit the owner
// record). Email/phone stay owner-specific (a parent's contact info can
// legitimately differ from the rider's own), but fall back to the student's
// contact info if the owner never set their own.
function accountContactInfo(owner) {
  const student = owner && owner.studentId ? state.db.students.find((s) => s.id === owner.studentId) : null;
  return {
    student,
    name: (student && student.name) || (owner && owner.name) || "Unnamed",
    email: (owner && owner.email) || (student && student.contactEmail) || "",
    phone: (owner && owner.phone) || (student && student.contactPhone) || "",
  };
}

/* =========================================================
   BILLING — fee schedule, unbilled sessions, invoices
   ========================================================= */
function effectiveRate(owner) {
  const r = owner && owner.rate;
  if (r != null && r !== "" && !isNaN(Number(r))) return Number(r);
  return Number(state.db.billing.defaultRate) || 50;
}

// Every student is a billable account automatically — no setup step
// required. If they don't have a formal owner record yet (no custom rate,
// no horse linked to them), this returns a "virtual" account id
// ("student:<id>") that behaves like a real one for display/balance
// purposes; it only gets materialized into a real Owner record the moment
// something needs to be persisted against it (rate, line item, horse link).
function accountIdForStudent(studentId) {
  const owner = ownerForStudent(studentId);
  return owner ? owner.id : "student:" + studentId;
}

// Work sessions bill to the horse's owner; lessons bill to the student's
// account (even if the lesson horse belongs to someone else, e.g. a barn
// school horse) — since it's the student's family being billed for
// instruction time either way.
function accountIdForEvent(evt) {
  const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
  if (props.type === "lesson" && props.studentId) {
    return accountIdForStudent(props.studentId);
  }
  if (props.type === "work" && props.horseId) {
    const horse = state.db.horses.find((h) => h.id === props.horseId);
    const o = horse ? ownerForHorse(horse) : null;
    return o ? o.id : null;
  }
  return null;
}

function eventBillingLabel(evt) {
  const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
  if (props.type === "lesson") {
    return "Lesson — " + (props.studentName || "?") + (props.horseName ? " on " + props.horseName : "");
  }
  return "Work Session — " + (props.horseName || "?");
}

function eventDateStr(evt) {
  const iso = evt.start.dateTime || evt.start.date + "T12:00:00Z";
  return nyDateStringFromISO(iso);
}

// Completed calendar events are the source of truth for what's billable.
// Fetches a wide historical window (client-side filtered for "not yet
// invoiced") rather than paginating — fine for a single small barn's volume.
async function loadBillableEvents(forceRefresh) {
  if (!forceRefresh && state._billableEventsCache && Date.now() - state._billableEventsCache.at < 60000) {
    return state._billableEventsCache.events;
  }
  const timeMin = "2015-01-01T00:00:00Z";
  const timeMax = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const events = await calendarListEvents(timeMin, timeMax, { privateExtendedProperty: "completed=true" });
  state._billableEventsCache = { at: Date.now(), events };
  return events;
}

function unbilledEventsForAccount(events, accountId) {
  return events
    .filter((evt) => {
      const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
      if (props.invoiced === "true") return false;
      if (props.directPaid === "true") return false;
      return accountIdForEvent(evt) === accountId;
    })
    .sort((a, b) => eventDateStr(a).localeCompare(eventDateStr(b)));
}

// Every billable event for an account regardless of billing status — the
// basis for the itemized monthly history (unlike unbilledEventsForAccount,
// which only shows what's still owed).
function allEventsForAccount(events, accountId) {
  return events
    .filter((evt) => accountIdForEvent(evt) === accountId)
    .sort((a, b) => eventDateStr(a).localeCompare(eventDateStr(b)));
}

// "unbilled" | "paid_direct" | "invoiced_unpaid" | "invoiced_paid"
function eventStatus(evt) {
  const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
  if (props.invoiced === "true") {
    const inv = state.db.invoices.find((i) => i.id === props.invoiceId);
    return inv && inv.paid ? "invoiced_paid" : "invoiced_unpaid";
  }
  if (props.directPaid === "true") return "paid_direct";
  return "unbilled";
}

const STATUS_LABELS = {
  unbilled: "Unbilled",
  paid_direct: "Paid",
  invoiced_unpaid: "Invoiced — Unpaid",
  invoiced_paid: "Invoiced — Paid",
};
const STATUS_BADGE_CLASS = {
  unbilled: "unbilled",
  paid_direct: "paid",
  invoiced_unpaid: "unpaid",
  invoiced_paid: "paid",
};

async function markEventsInvoiced(events, invoiceId) {
  for (const evt of events) {
    const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
    const newProps = Object.assign({}, props, { invoiced: "true", invoiceId });
    await calendarPatchEvent(evt.id, { extendedProperties: { private: newProps } });
  }
}

// Marks a session as settled outside the invoice system (e.g. paid cash
// in person) — pulls it out of "unbilled" and into the account history as
// Paid, without ever generating an invoice line item for it.
async function markEventsDirectPaid(events) {
  for (const evt of events) {
    const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
    const newProps = Object.assign({}, props, { directPaid: "true" });
    await calendarPatchEvent(evt.id, { extendedProperties: { private: newProps } });
  }
}

// "Amount owed" = unbilled sessions (not yet on any invoice) + any
// invoices that have been created but not yet marked paid.
function unpaidInvoiceTotalForAccount(accountId) {
  return state.db.invoices
    .filter((inv) => inv.ownerId === accountId && !inv.paid)
    .reduce((sum, inv) => sum + Number(inv.total || 0), 0);
}

// Builds the list of billable accounts shown on the Accounts page: every
// student (auto — no setup needed) plus any owner that isn't already
// represented via a student (i.e. horse owners who aren't enrolled).
function getAllAccounts() {
  const list = [];
  const seenStudentIds = new Set();
  state.db.students.forEach((s) => {
    const owner = ownerForStudent(s.id);
    const info = owner ? accountContactInfo(owner) : null;
    list.push({
      accountId: owner ? owner.id : "student:" + s.id,
      name: s.name,
      email: info ? info.email : s.contactEmail,
      phone: info ? info.phone : s.contactPhone,
      rate: owner ? owner.rate : null,
      studentId: s.id,
    });
    seenStudentIds.add(s.id);
  });
  state.db.owners.forEach((o) => {
    if (o.studentId && seenStudentIds.has(o.studentId)) return;
    const info = accountContactInfo(o);
    list.push({ accountId: o.id, name: info.name, email: info.email, phone: info.phone, rate: o.rate, studentId: o.studentId || null });
  });
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/* =========================================================
   ROUTING / NAV
   ========================================================= */
function navigate(view, param) {
  state.currentView = view;
  document.querySelectorAll(".nav-link").forEach((b) => b.classList.toggle("active", b.dataset.route === view));

  if (view === "schedule") {
    showOnly("scheduleView");
    renderSchedule();
  } else if (view === "horses") {
    showOnly("horsesView");
    renderHorses();
  } else if (view === "horse-profile") {
    state.currentHorseId = param;
    showOnly("horseProfileView");
    renderHorseProfile(param);
  } else if (view === "students") {
    showOnly("studentsView");
    renderStudents();
  } else if (view === "student-profile") {
    state.currentStudentId = param;
    showOnly("studentProfileView");
    renderStudentProfile(param);
  } else if (view === "accounts") {
    showOnly("accountsView");
    renderAccounts();
  } else if (view === "account-profile") {
    // param may be a real owner id or a virtual "student:<id>" — resolve to
    // a real owner record (creating one on the fly if needed) so the rest
    // of the account page can always deal with a concrete record.
    const resolvedId = resolveOwnerOrStudentValue(param);
    state.currentAccountOwnerId = resolvedId;
    state._pendingLineItems = [];
    showOnly("accountProfileView");
    renderAccountProfile(resolvedId);
  }
}

document.querySelectorAll(".nav-link").forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.dataset.route));
});

/* =========================================================
   AVATAR HELPER (shared by horse cards, student cards, profiles, agenda)
   ========================================================= */
/* Google's Drive API "thumbnailLink" field is only meant for the Drive UI
   itself and frequently 403s or goes stale when hotlinked from another
   site. The public /thumbnail?id= endpoint is what Drive uses for
   embedding shared files and stays reliable as long as the file is
   shared "anyone with the link can view" (which driveUploadMedia sets). */
function driveThumbUrl(fileId, size) {
  if (!fileId) return "";
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size || 200}`;
}

function avatarEl(entity, sizeClass) {
  const cls = "horse-thumb" + (sizeClass ? " " + sizeClass : "");
  if (entity && entity.photo && entity.photo.fileId) {
    return el("img", {
      class: cls,
      src: driveThumbUrl(entity.photo.fileId, 160),
      alt: entity.name || "",
      onerror: (e) => { e.target.replaceWith(avatarFallback(entity, cls)); },
    });
  }
  return avatarFallback(entity, cls);
}

function avatarFallback(entity, cls) {
  const initial = entity && entity.name ? entity.name.trim().charAt(0).toUpperCase() : "?";
  return el("div", { class: cls + " horse-thumb-fallback" }, initial);
}

function mediaThumbImg(fileId, size) {
  const img = el("img", { src: driveThumbUrl(fileId, size) });
  img.addEventListener("error", () => {
    img.replaceWith(el("span", {}, "📷"));
  });
  return img;
}

/* =========================================================
   WEEK STRIP (reused by both horse profile and student profile)
   ========================================================= */
async function renderWeekStrip(containerSel, filterField, filterValue) {
  const container = $(containerSel);
  container.innerHTML = "<p class='muted small'>Loading this week's schedule…</p>";
  try {
    const today = todayStr();
    const dow = weekdayIndexOf(today);
    const weekStart = addDaysToDateStr(today, -dow);
    const queryMin = `${addDaysToDateStr(weekStart, -1)}T00:00:00Z`;
    const queryMax = `${addDaysToDateStr(weekStart, 8)}T00:00:00Z`;

    const events = await calendarListEvents(queryMin, queryMax, { privateExtendedProperty: `${filterField}=${filterValue}` });

    const byDate = {};
    events.forEach((evt) => {
      const startIso = evt.start.dateTime || evt.start.date + "T12:00:00Z";
      const dateStr = nyDateStringFromISO(startIso);
      (byDate[dateStr] = byDate[dateStr] || []).push(evt);
    });

    container.innerHTML = "";
    const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let i = 0; i < 7; i++) {
      const dateStr = addDaysToDateStr(weekStart, i);
      const dayEvents = byDate[dateStr] || [];
      const isToday = dateStr === today;
      const cell = el(
        "div",
        { class: "week-day" + (dayEvents.length ? " scheduled" : "") + (isToday ? " today" : "") },
        el("div", { class: "wd-label" }, dayLabels[i]),
        el("div", { class: "wd-date" }, fmtDateShort(dateStr))
      );
      dayEvents.forEach((evt) => {
        const t = evt.start.dateTime ? fmtTimeHuman(evt.start.dateTime) : "All day";
        cell.appendChild(el("div", { class: "wd-time" }, t));
      });
      container.appendChild(cell);
    }
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("p", { class: "muted small" }, "Couldn't load this week's schedule."));
  }
}

/* =========================================================
   SCHEDULE VIEW — single day at a time, with a toggle at the
   top to also show the full Google Calendar embed. Shows both
   horse work sessions and student lessons together.
   ========================================================= */
async function renderSchedule() {
  updateDayNavLabel();
  const list = $("#agendaList");
  list.innerHTML = "<p class='muted'>Loading schedule…</p>";
  try {
    const dayBefore = addDaysToDateStr(state.scheduleDate, -1);
    const dayAfter = addDaysToDateStr(state.scheduleDate, 2);
    const timeMin = `${dayBefore}T00:00:00Z`;
    const timeMax = `${dayAfter}T00:00:00Z`;
    const events = await calendarListEvents(timeMin, timeMax);
    const dayEvents = events.filter((evt) => {
      const startIso = evt.start.dateTime ? evt.start.dateTime : evt.start.date + "T12:00:00Z";
      return nyDateStringFromISO(startIso) === state.scheduleDate;
    });
    renderDayAgenda(dayEvents);
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("p", { class: "empty-note" }, "Could not load the schedule: " + err.message));
  }
}

function updateDayNavLabel() {
  const label = fmtDateHuman(state.scheduleDate) + (state.scheduleDate === todayStr() ? " — Today" : "");
  $("#dayNavLabel").textContent = label;
}

function renderDayAgenda(events) {
  const list = $("#agendaList");
  list.innerHTML = "";
  if (!events.length) {
    list.appendChild(el("p", { class: "empty-note" }, "No one scheduled for this day. Click “+ Add Work Session” or “+ Add Lesson” to get started."));
    return;
  }
  const dayCard = el("div", { class: "agenda-day" });
  events.forEach((evt) => {
    const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
    const type = props.type || "work";
    const time = evt.start.dateTime ? fmtTimeHuman(evt.start.dateTime) : "All day";
    const isCompleted = props.completed === "true";

    const checkboxAttrs = {
      type: "checkbox",
      class: "agenda-checkbox",
      title: "Mark completed",
      onchange: (e) => toggleEventCompleted(evt, e.target.checked),
    };
    if (isCompleted) checkboxAttrs.checked = "checked";

    let row;
    if (type === "lesson") {
      const student = state.db.students.find((s) => s.id === props.studentId);
      const horse = state.db.horses.find((h) => h.id === props.horseId);
      const displayName = (student ? student.name : props.studentName || "Student") + (horse ? " — " + horse.name : "");
      row = el(
        "div",
        { class: "agenda-row" + (isCompleted ? " completed" : "") },
        el(
          "div",
          { class: "agenda-left" },
          el(
            "div",
            { class: "agenda-header-row" },
            el("input", checkboxAttrs),
            el("div", { class: "agenda-time" }, time)
          ),
          el(
            "div",
            { class: "agenda-info" },
            el(
              "div",
              { class: "agenda-horse" },
              avatarEl(student, "small"),
              el("span", { class: "type-badge lesson" }, "Lesson"),
              el("span", {
                class: "agenda-name-link",
                onclick: () => {
                  if (student) navigate("student-profile", student.id);
                  else showToast("This lesson isn't linked to a student profile.", true);
                },
              }, displayName),
              isCompleted ? el("span", { class: "completed-badge" }, "✓ Completed") : null
            ),
            el("div", { class: "agenda-rider" }, props.instructor ? "Instructor: " + props.instructor : "")
          )
        ),
        el(
          "div",
          { class: "agenda-actions" },
          el("button", { class: "btn btn-ghost btn-icon danger", title: "Remove from schedule", onclick: () => deleteSession(evt.id) }, "🗑️"),
          el(
            "div",
            { class: "agenda-other-actions" },
            evt.htmlLink ? el("a", { class: "btn btn-ghost btn-icon", title: "Open in Google Calendar", href: evt.htmlLink, target: "_blank", rel: "noopener" }, "🗓️") : null,
            el("button", {
              class: "btn btn-ghost btn-icon",
              title: "Log Lesson",
              onclick: () => {
                if (student) {
                  openLessonLogModal(student.id, horse ? horse.id : "", state.scheduleDate, null, {
                    instructor: props.instructor,
                    notes: evt.description || "",
                  });
                } else showToast("This lesson isn't linked to a student profile.", true);
              },
            }, "📝"),
            el("button", { class: "btn btn-ghost btn-icon", title: "Edit", onclick: () => openLessonModal(evt) }, "✏️")
          )
        )
      );
    } else {
      const horse = state.db.horses.find((h) => h.id === props.horseId);
      const horseName = horse ? horse.name : props.horseName || evt.summary || "Session";
      const rider = props.rider || "";
      row = el(
        "div",
        { class: "agenda-row" + (isCompleted ? " completed" : "") },
        el(
          "div",
          { class: "agenda-left" },
          el(
            "div",
            { class: "agenda-header-row" },
            el("input", checkboxAttrs),
            el("div", { class: "agenda-time" }, time)
          ),
          el(
            "div",
            { class: "agenda-info" },
            el(
              "div",
              { class: "agenda-horse" },
              avatarEl(horse, "small"),
              el("span", { class: "type-badge" }, "Work"),
              el("span", {
                class: "agenda-name-link",
                onclick: () => {
                  if (horse) navigate("horse-profile", horse.id);
                  else showToast("This session isn't linked to a horse profile.", true);
                },
              }, horseName),
              isCompleted ? el("span", { class: "completed-badge" }, "✓ Completed") : null
            ),
            el("div", { class: "agenda-rider" }, rider ? "Rider: " + rider : "")
          )
        ),
        el(
          "div",
          { class: "agenda-actions" },
          el("button", { class: "btn btn-ghost btn-icon danger", title: "Remove from schedule", onclick: () => deleteSession(evt.id) }, "🗑️"),
          el(
            "div",
            { class: "agenda-other-actions" },
            evt.htmlLink ? el("a", { class: "btn btn-ghost btn-icon", title: "Open in Google Calendar", href: evt.htmlLink, target: "_blank", rel: "noopener" }, "🗓️") : null,
            el("button", {
              class: "btn btn-ghost btn-icon",
              title: "Log Report Card",
              onclick: () => {
                if (horse) {
                  openReportCardModal(horse.id, state.scheduleDate, null, {
                    rider: props.rider,
                    notes: evt.description || "",
                  });
                } else showToast("This session isn't linked to a horse profile.", true);
              },
            }, "📝"),
            el("button", { class: "btn btn-ghost btn-icon", title: "Edit", onclick: () => openSessionModal(evt) }, "✏️")
          )
        )
      );
    }
    dayCard.appendChild(row);
  });
  list.appendChild(dayCard);
}

async function toggleEventCompleted(evt, isChecked) {
  const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
  const newProps = Object.assign({}, props, { completed: isChecked ? "true" : "false" });
  try {
    await calendarPatchEvent(evt.id, { extendedProperties: { private: newProps } });
    showToast(isChecked ? "Marked completed" : "Marked not completed");
    renderSchedule();
  } catch (err) {
    showToast("Couldn't update: " + err.message, true);
    renderSchedule();
  }
}

async function deleteSession(eventId) {
  if (!confirm("Remove this from the schedule?")) return;
  try {
    await calendarDeleteEvent(eventId);
    showToast("Removed from schedule");
    renderSchedule();
  } catch (err) {
    showToast("Couldn't remove: " + err.message, true);
  }
}

$("#prevDayBtn").addEventListener("click", () => {
  state.scheduleDate = addDaysToDateStr(state.scheduleDate, -1);
  renderSchedule();
});
$("#nextDayBtn").addEventListener("click", () => {
  state.scheduleDate = addDaysToDateStr(state.scheduleDate, 1);
  renderSchedule();
});
$("#todayBtn").addEventListener("click", () => {
  state.scheduleDate = todayStr();
  renderSchedule();
});

$("#toggleEmbedBtn").addEventListener("click", () => {
  const wrap = $("#calendarEmbedWrap");
  wrap.hidden = !wrap.hidden;
  $("#toggleEmbedBtn").textContent = wrap.hidden ? "Show full Google Calendar view ▾" : "Hide full Google Calendar view ▴";
});

/* ---- Add / Edit Work Session modal ---- */
function openSessionModal(evt) {
  const props = evt ? (evt.extendedProperties && evt.extendedProperties.private) || {} : {};
  state.editingSessionEventId = evt ? evt.id : null;
  state._editingSessionProps = props;
  $("#sessionModalTitle").textContent = evt ? "Edit Work Session" : "Add Work Session";
  $("#sessionSubmitBtn").textContent = evt ? "Update Session" : "Add to Schedule";

  const activeHorses = state.db.horses.filter((h) => h.active);
  const select = $("#sessionHorse");
  select.innerHTML = "";
  const horseList = activeHorses.slice();
  if (evt && props.horseId && !horseList.some((h) => h.id === props.horseId)) {
    const inactiveHorse = state.db.horses.find((h) => h.id === props.horseId);
    if (inactiveHorse) horseList.push(inactiveHorse);
  }
  if (!horseList.length) {
    select.appendChild(el("option", { value: "" }, "No active horses — add one first"));
  }
  horseList.forEach((h) => select.appendChild(el("option", { value: h.id }, h.name)));
  if (evt && props.horseId) select.value = props.horseId;

  if (evt) {
    $("#sessionRider").value = props.rider || "Shariti";
    const startIso = evt.start.dateTime || evt.start.date + "T12:00:00Z";
    $("#sessionDate").value = nyDateStringFromISO(startIso);
    $("#sessionTime").value = evt.start.dateTime ? nyTimeStringFromISO(evt.start.dateTime) : "09:00";
    $("#sessionNotes").value = evt.description || "";
  } else {
    $("#sessionRider").value = "Shariti";
    $("#sessionDate").value = state.scheduleDate || todayStr();
    $("#sessionTime").value = "09:00";
    $("#sessionNotes").value = "";
  }
  openModal("sessionModal");
}

$("#addSessionBtn").addEventListener("click", () => openSessionModal(null));

$("#sessionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const horseId = $("#sessionHorse").value;
  const horse = state.db.horses.find((h) => h.id === horseId);
  if (!horse) { showToast("Please add a horse first.", true); return; }
  const rider = $("#sessionRider").value;
  const date = $("#sessionDate").value;
  const time = $("#sessionTime").value;
  const notes = $("#sessionNotes").value;
  const endInfo = addOneHourToTime(time, date);
  const editingId = state.editingSessionEventId;
  const existingProps = editingId && state._editingSessionProps ? state._editingSessionProps : {};

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const evtBody = {
      summary: `${horse.name} — ${rider}`,
      description: notes,
      start: { dateTime: `${date}T${time}:00`, timeZone: CONFIG.TIMEZONE },
      end: { dateTime: `${endInfo.date}T${endInfo.time}:00`, timeZone: CONFIG.TIMEZONE },
      extendedProperties: { private: Object.assign({}, existingProps, { type: "work", horseId: horse.id, horseName: horse.name, rider }) },
    };
    if (editingId) {
      await calendarPatchEvent(editingId, evtBody);
    } else {
      await calendarCreateEvent(evtBody);
    }
    closeModal("sessionModal");
    showToast(editingId ? "Session updated" : "Added to Google Calendar");
    state.editingSessionEventId = null;
    state.scheduleDate = date;
    renderSchedule();
  } catch (err) {
    showToast("Couldn't save session: " + err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});

/* ---- Add / Edit Lesson modal (calendar) ---- */
function openLessonModal(evt) {
  const props = evt ? (evt.extendedProperties && evt.extendedProperties.private) || {} : {};
  state.editingLessonEventId = evt ? evt.id : null;
  state._editingLessonProps = props;
  $("#lessonModalTitle").textContent = evt ? "Edit Lesson" : "Add Lesson";
  $("#lessonSubmitBtn").textContent = evt ? "Update Lesson" : "Add to Schedule";

  const activeStudents = state.db.students.filter((s) => s.active);
  const studentSelect = $("#lessonStudent");
  studentSelect.innerHTML = "";
  const studentList = activeStudents.slice();
  if (evt && props.studentId && !studentList.some((s) => s.id === props.studentId)) {
    const inactiveStudent = state.db.students.find((s) => s.id === props.studentId);
    if (inactiveStudent) studentList.push(inactiveStudent);
  }
  if (!studentList.length) studentSelect.appendChild(el("option", { value: "" }, "No active students — add one first"));
  studentList.forEach((s) => studentSelect.appendChild(el("option", { value: s.id }, s.name)));
  if (evt && props.studentId) studentSelect.value = props.studentId;

  const activeHorses = state.db.horses.filter((h) => h.active);
  const horseSelect = $("#lessonHorse");
  horseSelect.innerHTML = "";
  const horseList = activeHorses.slice();
  if (evt && props.horseId && !horseList.some((h) => h.id === props.horseId)) {
    const inactiveHorse = state.db.horses.find((h) => h.id === props.horseId);
    if (inactiveHorse) horseList.push(inactiveHorse);
  }
  if (!horseList.length) horseSelect.appendChild(el("option", { value: "" }, "No active horses — add one first"));
  horseList.forEach((h) => horseSelect.appendChild(el("option", { value: h.id }, h.name)));
  if (evt && props.horseId) horseSelect.value = props.horseId;

  if (evt) {
    const startIso = evt.start.dateTime || evt.start.date + "T12:00:00Z";
    $("#lessonDate").value = nyDateStringFromISO(startIso);
    $("#lessonTime").value = evt.start.dateTime ? nyTimeStringFromISO(evt.start.dateTime) : "09:00";
    $("#lessonNotes").value = evt.description || "";
  } else {
    $("#lessonDate").value = state.scheduleDate || todayStr();
    $("#lessonTime").value = "09:00";
    $("#lessonNotes").value = "";
  }
  openModal("lessonModal");
}

$("#addLessonBtn").addEventListener("click", () => openLessonModal(null));

$("#lessonForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const studentId = $("#lessonStudent").value;
  const horseId = $("#lessonHorse").value;
  const student = state.db.students.find((s) => s.id === studentId);
  const horse = state.db.horses.find((h) => h.id === horseId);
  if (!student || !horse) { showToast("Please make sure a student and horse are both added and selected.", true); return; }
  const instructor = $("#lessonInstructor").value;
  const date = $("#lessonDate").value;
  const time = $("#lessonTime").value;
  const notes = $("#lessonNotes").value;
  const endInfo = addOneHourToTime(time, date);
  const editingId = state.editingLessonEventId;
  const existingProps = editingId && state._editingLessonProps ? state._editingLessonProps : {};

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    const evtBody = {
      summary: `${student.name} Lesson — ${horse.name}`,
      description: notes,
      start: { dateTime: `${date}T${time}:00`, timeZone: CONFIG.TIMEZONE },
      end: { dateTime: `${endInfo.date}T${endInfo.time}:00`, timeZone: CONFIG.TIMEZONE },
      extendedProperties: { private: Object.assign({}, existingProps, { type: "lesson", studentId: student.id, studentName: student.name, horseId: horse.id, horseName: horse.name, instructor }) },
    };
    if (editingId) {
      await calendarPatchEvent(editingId, evtBody);
    } else {
      await calendarCreateEvent(evtBody);
    }
    closeModal("lessonModal");
    showToast(editingId ? "Lesson updated" : "Lesson added to Google Calendar");
    state.editingLessonEventId = null;
    state.scheduleDate = date;
    renderSchedule();
  } catch (err) {
    showToast("Couldn't save lesson: " + err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});

/* =========================================================
   HORSES VIEW
   ========================================================= */
function renderHorses() {
  const grid = $("#horsesGrid");
  grid.innerHTML = "";
  let horses = state.db.horses.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (state.horseFilter === "active") horses = horses.filter((h) => h.active);
  else if (state.horseFilter === "inactive") horses = horses.filter((h) => !h.active);

  if (!horses.length) {
    grid.appendChild(el("p", { class: "empty-note" }, "No horses to show yet."));
    return;
  }

  horses.forEach((h) => {
    const programLine = h.programDaysPerWeek ? `${h.programDaysPerWeek}x/week` + (h.programNotes ? " · " + h.programNotes : "") : (h.programNotes || "");
    const card = el(
      "div",
      { class: "horse-card" + (h.active ? "" : " inactive"), onclick: () => navigate("horse-profile", h.id) },
      el("div", { class: "horse-card-top" }, avatarEl(h), el("h3", {}, h.name)),
      el("span", { class: "badge" + (h.active ? "" : " inactive") }, h.active ? "Active" : "Inactive"),
      el("p", { class: "muted small" }, [h.breed, h.age ? h.age + " yrs" : ""].filter(Boolean).join(" · ") || " "),
      programLine ? el("p", { class: "muted small" }, "Program: " + programLine) : null
    );
    grid.appendChild(card);
  });
}

document.querySelectorAll(".horse-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".horse-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.horseFilter = btn.dataset.filter;
    renderHorses();
  });
});

/* ---- Add / Edit Horse modal ---- */
function openHorseModal(horse) {
  $("#horseModalTitle").textContent = horse ? "Edit Horse" : "Add Horse";
  $("#horseId").value = horse ? horse.id : "";
  $("#horseName").value = horse ? horse.name : "";
  $("#horseBreed").value = horse ? horse.breed || "" : "";
  $("#horseAge").value = horse ? horse.age || "" : "";
  populateOwnerSelect(horse ? horse.ownerId || "" : "");
  $("#horseProgramDays").value = horse && horse.programDaysPerWeek != null ? horse.programDaysPerWeek : "";
  $("#horseProgramNotes").value = horse ? horse.programNotes || "" : "";
  $("#horseNotes").value = horse ? horse.notes || "" : "";
  $("#horseActive").checked = horse ? !!horse.active : true;
  $("#horsePhoto").value = "";

  const previewWrap = $("#horsePhotoPreviewWrap");
  if (horse && horse.photo && horse.photo.fileId) {
    $("#horsePhotoPreview").src = driveThumbUrl(horse.photo.fileId, 200);
    previewWrap.hidden = false;
  } else {
    previewWrap.hidden = true;
  }

  openModal("horseModal");
}

$("#addHorseBtn").addEventListener("click", () => openHorseModal(null));

// Shared by the horse-modal "Owner/Lessor" picker and the Fee Schedule's
// rate-override picker: lists existing owner accounts plus any student who
// doesn't have one yet (value "student:<id>") so you can put a horse — or a
// custom rate — directly on a student's account with no separate "add
// owner" step. Selecting a student resolves to a real owner id on save via
// resolveOwnerOrStudentValue(), which creates one on the fly if needed.
function fillOwnerOrStudentSelect(select, selectedValue, noneLabel) {
  if (!select) return;
  select.innerHTML = "";
  if (noneLabel) select.appendChild(el("option", { value: "" }, noneLabel));

  const owners = state.db.owners.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (owners.length) {
    const ownerGroup = el("optgroup", { label: "Existing owner accounts" });
    owners.forEach((o) => {
      const info = accountContactInfo(o);
      ownerGroup.appendChild(
        el("option", { value: o.id }, info.name + (o.studentId ? " (student)" : "") + (info.email ? " — " + info.email : ""))
      );
    });
    select.appendChild(ownerGroup);
  }

  const unlinkedStudents = state.db.students
    .filter((s) => !ownerForStudent(s.id))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (unlinkedStudents.length) {
    const studentGroup = el("optgroup", { label: "Students (same account as...)" });
    unlinkedStudents.forEach((s) => {
      studentGroup.appendChild(el("option", { value: "student:" + s.id }, s.name));
    });
    select.appendChild(studentGroup);
  }

  select.value = selectedValue || "";
}

function populateOwnerSelect(selectedId) {
  fillOwnerOrStudentSelect($("#horseOwnerId"), selectedId, "— No owner linked —");
}

// Reuses a student's existing owner account if they already have one
// (e.g. from a previously linked horse); otherwise creates one from their
// student contact info so it can be reused by future horses on the same account.
function getOrCreateOwnerForStudent(studentId) {
  const existing = ownerForStudent(studentId);
  if (existing) return existing;
  const student = state.db.students.find((s) => s.id === studentId);
  if (!student) return null;
  const owner = {
    id: uuid(),
    studentId: student.id,
    name: student.name,
    email: student.contactEmail || "",
    phone: student.contactPhone || "",
    rate: null,
    notes: "",
    createdAt: new Date().toISOString(),
  };
  state.db.owners.push(owner);
  return owner;
}

// Resolves the value of any select populated by fillOwnerOrStudentSelect
// into a real owner id, creating the owner account if a "student:<id>"
// option was chosen.
function resolveOwnerOrStudentValue(value) {
  if (!value) return null;
  if (value.startsWith("student:")) {
    const owner = getOrCreateOwnerForStudent(value.slice("student:".length));
    return owner ? owner.id : null;
  }
  return value;
}

const horseAddOwnerBtnEl = $("#horseAddOwnerBtn");
if (horseAddOwnerBtnEl) {
  horseAddOwnerBtnEl.addEventListener("click", () => openOwnerModal(null, { fromHorseModal: true }));
}

$("#horseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#horseId").value || uuid();
  const isNew = !$("#horseId").value;
  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    let photo = null;
    if (!isNew) {
      const existing = state.db.horses.find((h) => h.id === id);
      photo = existing ? existing.photo || null : null;
    }
    const photoFile = $("#horsePhoto").files[0];
    if (photoFile) {
      submitBtn.textContent = "Uploading photo…";
      const uploaded = await driveUploadMedia(photoFile, state.profilesFolderId);
      photo = {
        fileId: uploaded.id,
        mimeType: uploaded.mimeType,
        webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
        thumbnailLink: uploaded.thumbnailLink || "",
      };
    }

    const ownerSelectVal = resolveOwnerOrStudentValue($("#horseOwnerId").value);

    const horseData = {
      id,
      name: $("#horseName").value.trim(),
      breed: $("#horseBreed").value.trim(),
      age: $("#horseAge").value.trim(),
      ownerId: ownerSelectVal,
      programDaysPerWeek: $("#horseProgramDays").value ? Number($("#horseProgramDays").value) : null,
      programNotes: $("#horseProgramNotes").value.trim(),
      notes: $("#horseNotes").value.trim(),
      active: $("#horseActive").checked,
      photo,
      createdAt: isNew ? new Date().toISOString() : undefined,
    };

    if (isNew) {
      state.db.horses.push(horseData);
    } else {
      const idx = state.db.horses.findIndex((h) => h.id === id);
      state.db.horses[idx] = Object.assign({}, state.db.horses[idx], horseData, {
        createdAt: state.db.horses[idx].createdAt,
      });
    }
    await saveDb();
    closeModal("horseModal");
    showToast(isNew ? "Horse added" : "Horse updated");
    if (state.currentView === "horse-profile") renderHorseProfile(id);
    else renderHorses();
  } catch (err) {
    showToast("Couldn't save horse: " + err.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Horse";
  }
});

/* =========================================================
   HORSE PROFILE VIEW
   ========================================================= */
$("#backToHorsesBtn").addEventListener("click", () => navigate("horses"));

function renderHorseProfile(horseId) {
  const horse = state.db.horses.find((h) => h.id === horseId);
  const header = $("#horseProfileHeader");
  if (!horse) {
    header.innerHTML = "<p>Horse not found.</p>";
    return;
  }
  header.innerHTML = "";
  header.appendChild(
    el(
      "div",
      { class: "profile-title-row" },
      avatarEl(horse, "large"),
      el(
        "div",
        {},
        el("h1", {}, horse.name),
        el("span", { class: "badge" + (horse.active ? "" : " inactive") }, horse.active ? "Active in program" : "Inactive")
      )
    )
  );
  const horseOwner = ownerForHorse(horse);
  header.appendChild(
    el(
      "div",
      { class: "profile-meta" },
      horse.breed ? el("span", {}, "Breed: " + escapeHtml(horse.breed)) : null,
      horse.age ? el("span", {}, "Age: " + escapeHtml(horse.age)) : null,
      horse.programDaysPerWeek ? el("span", {}, "Program: " + horse.programDaysPerWeek + "x/week" + (horse.programNotes ? " (" + escapeHtml(horse.programNotes) + ")" : "")) : null,
      horseOwner
        ? el("span", { class: "agenda-name-link", onclick: () => navigate("account-profile", horseOwner.id) }, "Owner/Lessor: " + escapeHtml(horseOwner.name))
        : el("span", { class: "muted" }, "No owner/lessor linked")
    )
  );
  if (horse.notes) header.appendChild(el("p", { class: "muted" }, horse.notes));

  header.appendChild(
    el(
      "div",
      { class: "profile-actions" },
      el("button", { class: "btn btn-ghost small", onclick: () => openHorseModal(horse) }, "Edit Info"),
      el(
        "button",
        { class: "btn btn-ghost small", onclick: () => toggleHorseActive(horse) },
        horse.active ? "Mark Inactive" : "Mark Active"
      ),
      el("button", { class: "btn btn-danger small", onclick: () => deleteHorse(horse) }, "Delete Horse")
    )
  );

  renderWeekStrip("#horseWeekSchedule", "horseId", horseId);
  renderReportCards(horseId);
}

async function toggleHorseActive(horse) {
  horse.active = !horse.active;
  try {
    await saveDb();
    showToast(horse.active ? "Marked active" : "Marked inactive");
    renderHorseProfile(horse.id);
  } catch (err) {
    horse.active = !horse.active;
    showToast("Couldn't update: " + err.message, true);
  }
}

async function deleteHorse(horse) {
  const ok = confirm(
    `Delete ${horse.name}? This also deletes their report card history in the app.\n\nCalendar sessions and uploaded photos will NOT be deleted automatically — remove those separately if you want them gone too.\n\nThis can't be undone.`
  );
  if (!ok) return;

  const horseIdx = state.db.horses.findIndex((h) => h.id === horse.id);
  const removedHorse = state.db.horses[horseIdx];
  const removedCards = state.db.reportCards.filter((c) => c.horseId === horse.id);
  state.db.horses = state.db.horses.filter((h) => h.id !== horse.id);
  state.db.reportCards = state.db.reportCards.filter((c) => c.horseId !== horse.id);

  try {
    await saveDb();
    showToast("Horse deleted");
    navigate("horses");
  } catch (err) {
    state.db.horses.splice(horseIdx, 0, removedHorse);
    state.db.reportCards = state.db.reportCards.concat(removedCards);
    showToast("Couldn't delete horse: " + err.message, true);
  }
}

/* =========================================================
   OWNER CONTACT INFO — edited via a modal from the horse profile,
   student profile, or account page; there is no standalone Owners page.
   An owner account can be linked to multiple horses and (optionally) to
   one student, for billing purposes.
   ========================================================= */
function populateOwnerStudentSelect(selectedId) {
  const currentOwnerId = $("#ownerId").value || null;
  const select = $("#ownerStudentId");
  const students = state.db.students.slice().sort((a, b) => a.name.localeCompare(b.name));
  select.innerHTML = "";
  select.appendChild(el("option", { value: "" }, "— Not a student —"));
  students.forEach((s) => {
    // A student should only map to one owner account — skip students
    // already linked to a *different* owner than the one being edited.
    const existingOwner = ownerForStudent(s.id);
    if (existingOwner && existingOwner.id !== currentOwnerId) return;
    select.appendChild(el("option", { value: s.id }, s.name));
  });
  select.value = selectedId || "";
}

// When an owner is linked to a student, the name field locks to that
// student's live name (editable only from the Student profile) so the two
// records can never drift apart again — this was the root cause of names
// not "connecting" between Students and Accounts.
function syncOwnerNameFieldLock() {
  const studentId = $("#ownerStudentId").value;
  const nameInput = $("#ownerName");
  const note = $("#ownerNameSyncNote");
  if (studentId) {
    const student = state.db.students.find((s) => s.id === studentId);
    if (student) {
      nameInput.value = student.name || "";
      nameInput.disabled = true;
      if (note) note.hidden = false;
      if (!$("#ownerEmail").value.trim()) $("#ownerEmail").value = student.contactEmail || "";
      if (!$("#ownerPhone").value.trim()) $("#ownerPhone").value = student.contactPhone || "";
      return;
    }
  }
  nameInput.disabled = false;
  if (note) note.hidden = true;
}

function openOwnerModal(owner, opts) {
  $("#ownerModalTitle").textContent = owner ? "Edit Owner" : "Add Owner";
  $("#ownerId").value = owner ? owner.id : "";
  $("#ownerName").value = owner ? owner.name : "";
  $("#ownerName").disabled = false;
  $("#ownerEmail").value = owner ? owner.email || "" : "";
  $("#ownerPhone").value = owner ? owner.phone || "" : "";
  $("#ownerNotes").value = owner ? owner.notes || "" : "";
  populateOwnerStudentSelect(owner ? owner.studentId || "" : "");
  syncOwnerNameFieldLock();
  state._ownerModalContext = opts || null;
  openModal("ownerModal");
}

$("#ownerStudentId").addEventListener("change", syncOwnerNameFieldLock);

$("#ownerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#ownerId").value || uuid();
  const isNew = !$("#ownerId").value;
  const submitBtn = $("#ownerSubmitBtn");
  submitBtn.disabled = true;
  try {
    const linkedStudentId = $("#ownerStudentId").value || null;
    const linkedStudent = linkedStudentId ? state.db.students.find((s) => s.id === linkedStudentId) : null;
    const ownerData = {
      id,
      studentId: linkedStudentId,
      // Name always comes from the linked student when one is set, even if
      // the (disabled) field somehow held a different value.
      name: linkedStudent ? linkedStudent.name : $("#ownerName").value.trim(),
      email: $("#ownerEmail").value.trim(),
      phone: $("#ownerPhone").value.trim(),
      notes: $("#ownerNotes").value.trim(),
      createdAt: isNew ? new Date().toISOString() : undefined,
    };
    if (isNew) {
      state.db.owners.push(ownerData);
    } else {
      const idx = state.db.owners.findIndex((o) => o.id === id);
      state.db.owners[idx] = Object.assign({}, state.db.owners[idx], ownerData, {
        createdAt: state.db.owners[idx].createdAt,
      });
    }
    await saveDb();
    closeModal("ownerModal");
    showToast(isNew ? "Owner added" : "Owner updated");

    const ctx = state._ownerModalContext;
    state._ownerModalContext = null;
    if (ctx && ctx.fromHorseModal) {
      populateOwnerSelect(id);
    } else if (state.currentView === "account-profile") {
      renderAccountProfile(id);
    } else {
      renderAccounts();
    }
  } catch (err) {
    showToast("Couldn't save owner: " + err.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Owner";
  }
});

async function deleteOwner(owner) {
  const linkedCount = state.db.horses.filter((h) => h.ownerId === owner.id).length;
  const ok = confirm(
    `Delete ${accountContactInfo(owner).name}?` +
      (linkedCount ? ` ${linkedCount} horse(s) will be unlinked from this owner.` : "") +
      `\n\nThis can't be undone.`
  );
  if (!ok) return;

  const idx = state.db.owners.findIndex((o) => o.id === owner.id);
  if (idx === -1) return;
  const removed = state.db.owners[idx];
  const touchedHorses = state.db.horses.filter((h) => h.ownerId === owner.id);
  touchedHorses.forEach((h) => { h.ownerId = null; });
  state.db.owners.splice(idx, 1);

  try {
    await saveDb();
    showToast("Owner deleted");
    navigate("accounts");
  } catch (err) {
    state.db.owners.splice(idx, 0, removed);
    touchedHorses.forEach((h) => { h.ownerId = removed.id; });
    showToast("Couldn't delete owner: " + err.message, true);
  }
}

async function linkHorseToOwner(owner, horseId) {
  if (!horseId) { showToast("Choose a horse first.", true); return; }
  const horse = state.db.horses.find((h) => h.id === horseId);
  if (!horse) return;
  const prevOwnerId = horse.ownerId || null;
  horse.ownerId = owner.id;
  try {
    await saveDb();
    showToast(`${horse.name} linked to ${accountContactInfo(owner).name}`);
    renderAccountProfile(owner.id);
  } catch (err) {
    horse.ownerId = prevOwnerId;
    showToast("Couldn't link horse: " + err.message, true);
  }
}

async function unlinkHorseFromOwner(horse) {
  const prevOwnerId = horse.ownerId;
  horse.ownerId = null;
  try {
    await saveDb();
    showToast(`${horse.name} unlinked`);
    renderAccountProfile(prevOwnerId);
  } catch (err) {
    horse.ownerId = prevOwnerId;
    showToast("Couldn't unlink horse: " + err.message, true);
  }
}

/* =========================================================
   ACCOUNTS — fee schedule + per-account balances & invoices
   ========================================================= */
$("#addAccountBtn").addEventListener("click", () => openOwnerModal(null));

function renderAccounts() {
  $("#defaultRateInput").value = state.db.billing.defaultRate;

  const overridesList = $("#rateOverridesList");
  overridesList.innerHTML = "";
  const overridden = state.db.owners
    .filter((o) => o.rate != null && o.rate !== "")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!overridden.length) {
    overridesList.appendChild(el("p", { class: "muted small" }, "No custom rates yet — everyone bills at the default rate."));
  } else {
    overridden.forEach((o) => {
      overridesList.appendChild(
        el(
          "div",
          { class: "report-card-head" },
          el("span", {}, accountContactInfo(o).name + " — $" + effectiveRate(o) + "/session"),
          el("button", { class: "btn btn-ghost small", onclick: () => removeRateOverride(o) }, "Remove")
        )
      );
    });
  }
  fillOwnerOrStudentSelect($("#rateOverrideOwnerSelect"), "", "— Choose owner or student —");

  const catalogList = $("#feeCatalogList");
  catalogList.innerHTML = "";
  const fees = state.db.billing.feeCatalog || [];
  if (!fees.length) {
    catalogList.appendChild(el("p", { class: "muted small" }, "No extra fees defined yet."));
  } else {
    fees.forEach((f) => {
      catalogList.appendChild(
        el(
          "div",
          { class: "report-card-head" },
          el("span", {}, f.name + " — $" + Number(f.amount).toFixed(2)),
          el("button", { class: "btn btn-ghost small", onclick: () => removeFeeCatalogItem(f) }, "Remove")
        )
      );
    });
  }

  renderAccountsGrid();
}

async function renderAccountsGrid() {
  const grid = $("#accountsGrid");
  grid.innerHTML = "";
  grid.appendChild(el("p", { class: "empty-note" }, "Loading balances…"));

  const accounts = getAllAccounts();
  if (!accounts.length) {
    grid.innerHTML = "";
    grid.appendChild(el("p", { class: "empty-note" }, "No students or horse owners yet."));
    return;
  }

  let events;
  try {
    events = await loadBillableEvents();
  } catch (err) {
    grid.innerHTML = "";
    grid.appendChild(el("p", { class: "empty-note" }, "Couldn't load session history: " + err.message));
    return;
  }
  if (state.currentView !== "accounts") return;

  grid.innerHTML = "";
  accounts.forEach((acct) => {
    const unbilled = unbilledEventsForAccount(events, acct.accountId);
    const unbilledTotal = unbilled.length * effectiveRate(acct);
    const unpaidInvoices = unpaidInvoiceTotalForAccount(acct.accountId);
    const owed = unbilledTotal + unpaidInvoices;
    grid.appendChild(
      el(
        "div",
        { class: "horse-card", onclick: () => navigate("account-profile", acct.accountId) },
        el("h3", {}, acct.name),
        el("p", { class: "muted small" }, unbilled.length + " unbilled session" + (unbilled.length === 1 ? "" : "s")),
        el("span", { class: "badge " + (owed > 0 ? "unpaid" : "paid") }, owed > 0 ? "$" + owed.toFixed(2) + " owed" : "Paid up")
      )
    );
  });
}

$("#saveDefaultRateBtn").addEventListener("click", async () => {
  const val = Number($("#defaultRateInput").value);
  if (isNaN(val) || val < 0) { showToast("Enter a valid rate.", true); return; }
  const prev = state.db.billing.defaultRate;
  state.db.billing.defaultRate = val;
  try {
    await saveDb();
    showToast("Default rate saved");
    renderAccounts();
  } catch (err) {
    state.db.billing.defaultRate = prev;
    showToast("Couldn't save: " + err.message, true);
  }
});

$("#addRateOverrideBtn").addEventListener("click", async () => {
  const ownerId = resolveOwnerOrStudentValue($("#rateOverrideOwnerSelect").value);
  const amount = Number($("#rateOverrideAmount").value);
  if (!ownerId) { showToast("Choose an owner or student first.", true); return; }
  if (isNaN(amount) || amount < 0) { showToast("Enter a valid rate.", true); return; }
  const owner = state.db.owners.find((o) => o.id === ownerId);
  if (!owner) { showToast("Owner not found.", true); return; }
  const prevRate = owner.rate;
  owner.rate = amount;
  try {
    await saveDb();
    showToast(`${accountContactInfo(owner).name}'s rate set to $${amount}`);
    $("#rateOverrideAmount").value = "";
    renderAccounts();
  } catch (err) {
    owner.rate = prevRate;
    showToast("Couldn't save: " + err.message, true);
  }
});

async function removeRateOverride(owner) {
  const prevRate = owner.rate;
  owner.rate = null;
  try {
    await saveDb();
    showToast(`${accountContactInfo(owner).name} back to default rate`);
    renderAccounts();
  } catch (err) {
    owner.rate = prevRate;
    showToast("Couldn't save: " + err.message, true);
  }
}

// Editable base rate right on the Account Profile page — same underlying
// field as the Fee Schedule's rate overrides, just more convenient to
// change from the account you're already looking at. Leaving it blank
// clears the override and falls back to the default rate (e.g. Laken, as
// the trainer, is set to $0 since she isn't a paying client).
async function saveAccountRate(owner) {
  const raw = $("#accountRateInput").value.trim();
  const prevRate = owner.rate;
  if (raw === "") {
    owner.rate = null;
  } else {
    const amount = Number(raw);
    if (isNaN(amount) || amount < 0) { showToast("Enter a valid rate.", true); return; }
    owner.rate = amount;
  }
  try {
    await saveDb();
    showToast(`${accountContactInfo(owner).name}'s rate ${owner.rate == null ? "reset to default" : "set to $" + owner.rate}`);
    renderAccountProfile(owner.id);
  } catch (err) {
    owner.rate = prevRate;
    showToast("Couldn't save: " + err.message, true);
  }
}

$("#addFeeCatalogBtn").addEventListener("click", async () => {
  const name = $("#newFeeName").value.trim();
  const amount = Number($("#newFeeAmount").value);
  if (!name) { showToast("Enter a fee name.", true); return; }
  if (isNaN(amount) || amount < 0) { showToast("Enter a valid amount.", true); return; }
  const fee = { id: uuid(), name, amount };
  state.db.billing.feeCatalog.push(fee);
  try {
    await saveDb();
    showToast("Fee added");
    $("#newFeeName").value = "";
    $("#newFeeAmount").value = "";
    renderAccounts();
  } catch (err) {
    state.db.billing.feeCatalog.pop();
    showToast("Couldn't save: " + err.message, true);
  }
});

async function removeFeeCatalogItem(fee) {
  const idx = state.db.billing.feeCatalog.findIndex((f) => f.id === fee.id);
  if (idx === -1) return;
  const removed = state.db.billing.feeCatalog[idx];
  state.db.billing.feeCatalog.splice(idx, 1);
  try {
    await saveDb();
    showToast("Fee removed");
    renderAccounts();
  } catch (err) {
    state.db.billing.feeCatalog.splice(idx, 0, removed);
    showToast("Couldn't save: " + err.message, true);
  }
}

/* ---- Individual account page: unbilled sessions + line items + invoices ---- */
$("#backToAccountsBtn").addEventListener("click", () => navigate("accounts"));

async function renderAccountProfile(ownerId) {
  const owner = state.db.owners.find((o) => o.id === ownerId);
  const header = $("#accountProfileHeader");
  const sessionsList = $("#unbilledSessionsList");
  const historyList = $("#invoiceHistoryList");

  if (!owner) {
    header.innerHTML = "<p>Account not found.</p>";
    sessionsList.innerHTML = "";
    $("#pendingLineItemsList").innerHTML = "";
    historyList.innerHTML = "";
    $("#accountHorseLinkRow").innerHTML = "";
    $("#accountHorseList").innerHTML = "";
    const historyContainer = $("#accountHistoryList");
    if (historyContainer) historyContainer.innerHTML = "";
    return;
  }

  const linkedStudent = owner.studentId ? state.db.students.find((s) => s.id === owner.studentId) : null;
  const info = accountContactInfo(owner);
  header.innerHTML = "";
  header.appendChild(el("div", { class: "profile-title-row" }, el("div", {}, el("h1", {}, info.name))));
  header.appendChild(
    el(
      "div",
      { class: "profile-meta" },
      info.email ? el("span", {}, escapeHtml(info.email)) : null,
      info.phone ? el("span", {}, escapeHtml(info.phone)) : null,
      linkedStudent ? el("span", { class: "agenda-name-link", onclick: () => navigate("student-profile", linkedStudent.id) }, "Student: " + escapeHtml(linkedStudent.name)) : null
    )
  );
  header.appendChild(
    el(
      "div",
      { class: "profile-meta", style: "align-items: center;" },
      el("label", { for: "accountRateInput" }, "Base rate: $"),
      el("input", {
        type: "number",
        id: "accountRateInput",
        min: "0",
        step: "0.01",
        value: owner.rate != null && owner.rate !== "" ? owner.rate : "",
        placeholder: String(Number(state.db.billing.defaultRate) || 50),
        style: "width: 80px;",
      }),
      el("span", { class: "muted small" }, "/session"),
      el("button", { class: "btn btn-ghost small", onclick: () => saveAccountRate(owner) }, "Save Rate"),
      el(
        "span",
        { class: "muted small" },
        owner.rate != null && owner.rate !== "" ? "Custom rate" : "Using default ($" + (Number(state.db.billing.defaultRate) || 50) + ")"
      )
    )
  );
  if (owner.notes) header.appendChild(el("p", { class: "muted" }, owner.notes));
  header.appendChild(
    el(
      "div",
      { class: "profile-actions" },
      el("button", { class: "btn btn-ghost small", onclick: () => openOwnerModal(owner) }, "Edit Contact Info"),
      el("button", { class: "btn btn-danger small", onclick: () => deleteOwner(owner) }, "Delete Account")
    )
  );

  // Linked horses — link/unlink directly from the account page.
  const linkRow = $("#accountHorseLinkRow");
  linkRow.innerHTML = "";
  const otherHorses = state.db.horses.slice().sort((a, b) => a.name.localeCompare(b.name)).filter((h) => h.ownerId !== owner.id);
  if (otherHorses.length) {
    const select = el(
      "select",
      { id: "accountLinkHorseSelect" },
      el("option", { value: "" }, "— Choose a horse to link —"),
      ...otherHorses.map((h) => el("option", { value: h.id }, h.name + (h.ownerId ? " (currently linked elsewhere)" : "")))
    );
    const linkBtn = el("button", { class: "btn btn-ghost small", onclick: () => linkHorseToOwner(owner, select.value) }, "Link Horse");
    linkRow.appendChild(select);
    linkRow.appendChild(linkBtn);
  }
  const horseList = $("#accountHorseList");
  horseList.innerHTML = "";
  const linkedHorses = state.db.horses.filter((h) => h.ownerId === owner.id).sort((a, b) => a.name.localeCompare(b.name));
  if (!linkedHorses.length) {
    horseList.appendChild(el("p", { class: "empty-note" }, "No horses linked to this account yet."));
  } else {
    linkedHorses.forEach((h) => {
      horseList.appendChild(
        el(
          "div",
          { class: "report-card-head" },
          el("span", { class: "agenda-name-link", onclick: () => navigate("horse-profile", h.id) }, h.name),
          el("button", { class: "btn btn-ghost small", onclick: () => unlinkHorseFromOwner(h) }, "Unlink")
        )
      );
    });
  }

  sessionsList.innerHTML = "";
  sessionsList.appendChild(el("p", { class: "empty-note" }, "Loading sessions…"));

  let events;
  try {
    events = await loadBillableEvents();
  } catch (err) {
    sessionsList.innerHTML = "";
    sessionsList.appendChild(el("p", { class: "empty-note" }, "Couldn't load session history: " + err.message));
    return;
  }
  if (state.currentAccountOwnerId !== ownerId) return; // navigated away while loading

  const unbilled = unbilledEventsForAccount(events, ownerId);
  state._currentUnbilledEvents = unbilled;
  const rate = effectiveRate(owner);
  const owed = unbilled.length * rate + unpaidInvoiceTotalForAccount(ownerId);
  header.appendChild(
    el(
      "p",
      {},
      el("span", { class: "badge " + (owed > 0 ? "unpaid" : "paid"), style: "font-size: 0.95rem; padding: 5px 14px;" }, owed > 0 ? "$" + owed.toFixed(2) + " owed" : "Paid up — $0.00 owed")
    )
  );

  sessionsList.innerHTML = "";
  if (!unbilled.length) {
    sessionsList.appendChild(el("p", { class: "empty-note" }, "No unbilled sessions."));
  } else {
    unbilled.forEach((evt) => {
      sessionsList.appendChild(
        el(
          "div",
          { class: "checkbox-label", style: "display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px;" },
          el(
            "label",
            { style: "display: flex; align-items: center; gap: 8px; flex: 1;" },
            el("input", {
              type: "checkbox",
              checked: "checked",
              class: "invoice-session-checkbox",
              "data-event-id": evt.id,
              "data-amount": String(rate),
              onchange: recalcInvoiceTotal,
            }),
            fmtDateShort(eventDateStr(evt)) + " — " + eventBillingLabel(evt) + " — $" + rate.toFixed(2)
          ),
          el(
            "button",
            { type: "button", class: "btn btn-ghost small", onclick: () => markSessionPaidNoInvoice(evt, ownerId) },
            "Mark Paid (no invoice)"
          )
        )
      );
    });
  }

  renderPendingLineItems();
  renderInvoiceHistory(ownerId);
  renderAccountHistory(ownerId, events);
  recalcInvoiceTotal();
}

function recalcInvoiceTotal() {
  let total = 0;
  document.querySelectorAll(".invoice-session-checkbox").forEach((cb) => {
    if (cb.checked) total += Number(cb.dataset.amount || 0);
  });
  state._pendingLineItems.forEach((item) => { total += Number(item.amount) || 0; });
  const label = $("#invoiceTotalLabel");
  if (label) label.textContent = "Total: $" + total.toFixed(2);
}

function renderPendingLineItems() {
  const list = $("#pendingLineItemsList");
  list.innerHTML = "";
  if (!state._pendingLineItems.length) {
    list.appendChild(el("p", { class: "muted small" }, "No additional line items added yet."));
  } else {
    state._pendingLineItems.forEach((item) => {
      list.appendChild(
        el(
          "div",
          { class: "report-card-head" },
          el("span", {}, item.label + " — $" + Number(item.amount).toFixed(2)),
          el("button", { class: "btn btn-ghost small", onclick: () => removePendingLineItem(item.id) }, "Remove")
        )
      );
    });
  }

  const select = $("#pendingFeeCatalogSelect");
  select.innerHTML = "";
  select.appendChild(el("option", { value: "" }, "— Custom item —"));
  (state.db.billing.feeCatalog || []).forEach((f) => {
    select.appendChild(el("option", { value: f.id }, f.name + " ($" + Number(f.amount).toFixed(2) + ")"));
  });
}

function removePendingLineItem(id) {
  state._pendingLineItems = state._pendingLineItems.filter((i) => i.id !== id);
  renderPendingLineItems();
  recalcInvoiceTotal();
}

$("#pendingFeeCatalogSelect").addEventListener("change", () => {
  const feeId = $("#pendingFeeCatalogSelect").value;
  if (!feeId) return;
  const fee = (state.db.billing.feeCatalog || []).find((f) => f.id === feeId);
  if (fee) {
    $("#pendingItemLabel").value = fee.name;
    $("#pendingItemAmount").value = fee.amount;
  }
});

$("#addPendingItemBtn").addEventListener("click", () => {
  const label = $("#pendingItemLabel").value.trim();
  const amount = Number($("#pendingItemAmount").value);
  if (!label) { showToast("Enter a description.", true); return; }
  if (isNaN(amount)) { showToast("Enter a valid amount.", true); return; }
  state._pendingLineItems.push({ id: uuid(), label, amount });
  $("#pendingItemLabel").value = "";
  $("#pendingItemAmount").value = "";
  $("#pendingFeeCatalogSelect").value = "";
  renderPendingLineItems();
  recalcInvoiceTotal();
});

$("#createInvoiceBtn").addEventListener("click", async () => {
  const ownerId = state.currentAccountOwnerId;
  const owner = state.db.owners.find((o) => o.id === ownerId);
  if (!owner) return;
  const btn = $("#createInvoiceBtn");

  const checkedBoxes = Array.from(document.querySelectorAll(".invoice-session-checkbox")).filter((cb) => cb.checked);
  const selectedEventIds = checkedBoxes.map((cb) => cb.dataset.eventId);
  const selectedEvents = (state._currentUnbilledEvents || []).filter((evt) => selectedEventIds.includes(evt.id));

  if (!selectedEvents.length && !state._pendingLineItems.length) {
    showToast("Select at least one session or add a line item.", true);
    return;
  }

  const rate = effectiveRate(owner);
  const lineItems = selectedEvents
    .map((evt) => ({
      id: uuid(),
      kind: "session",
      label: eventBillingLabel(evt),
      date: eventDateStr(evt),
      amount: rate,
      eventId: evt.id,
    }))
    .concat(
      state._pendingLineItems.map((item) => ({
        id: uuid(),
        kind: "fee",
        label: item.label,
        date: todayStr(),
        amount: Number(item.amount),
      }))
    );

  const total = lineItems.reduce((sum, li) => sum + Number(li.amount), 0);
  const invoice = { id: uuid(), ownerId, date: todayStr(), lineItems, total, paid: false, createdAt: new Date().toISOString() };

  btn.disabled = true;
  btn.textContent = "Creating invoice…";
  try {
    if (selectedEvents.length) await markEventsInvoiced(selectedEvents, invoice.id);
    state.db.invoices.push(invoice);
    await saveDb();
    showToast(`Invoice created — $${total.toFixed(2)}`);
    try {
      downloadInvoicePdf(invoice, owner);
    } catch (pdfErr) {
      console.warn("Invoice PDF generation failed", pdfErr);
      showToast("Invoice saved, but the PDF couldn't be generated — use Download PDF below to retry.", true);
    }
    state._pendingLineItems = [];
    await loadBillableEvents(true);
    renderAccountProfile(ownerId);
  } catch (err) {
    const idx = state.db.invoices.findIndex((i) => i.id === invoice.id);
    if (idx !== -1) state.db.invoices.splice(idx, 1);
    showToast("Couldn't create invoice: " + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Create Invoice";
  }
});

function renderInvoiceHistory(ownerId) {
  const list = $("#invoiceHistoryList");
  list.innerHTML = "";
  const owner = state.db.owners.find((o) => o.id === ownerId);
  const invoices = state.db.invoices.filter((i) => i.ownerId === ownerId).sort((a, b) => b.date.localeCompare(a.date));
  if (!invoices.length) {
    list.appendChild(el("p", { class: "empty-note" }, "No invoices yet."));
    return;
  }
  invoices.forEach((inv) => {
    const card = el("div", { class: "report-card" });
    card.appendChild(
      el(
        "div",
        { class: "report-card-head" },
        el("div", { class: "report-card-date" }, fmtDateHuman(inv.date)),
        el("div", { class: "report-card-rider" }, "$" + Number(inv.total).toFixed(2)),
        el("span", { class: "badge " + (inv.paid ? "paid" : "unpaid") }, inv.paid ? "Paid" : "Unpaid")
      )
    );
    const itemsList = el("ul", { class: "muted small" });
    inv.lineItems.forEach((li) => {
      itemsList.appendChild(
        el("li", {}, li.label + (li.date ? " (" + fmtDateShort(li.date) + ")" : "") + " — $" + Number(li.amount).toFixed(2))
      );
    });
    card.appendChild(itemsList);
    card.appendChild(
      el(
        "div",
        { class: "profile-actions" },
        el(
          "button",
          { class: "btn btn-ghost small", onclick: () => toggleInvoicePaid(inv) },
          inv.paid ? "Mark Unpaid" : "Mark Paid"
        ),
        owner ? el("button", { class: "btn btn-ghost small", onclick: () => downloadInvoicePdf(inv, owner) }, "Download PDF") : null,
        owner
          ? el("button", { class: "btn btn-ghost small", onclick: (e) => emailInvoicePdf(inv, owner, e.currentTarget) }, "Email Invoice")
          : null
      )
    );
    list.appendChild(card);
  });
}

async function toggleInvoicePaid(invoice) {
  const prev = invoice.paid;
  invoice.paid = !invoice.paid;
  try {
    await saveDb();
    showToast(invoice.paid ? "Marked paid" : "Marked unpaid");
    if (state.currentAccountOwnerId === invoice.ownerId) {
      renderInvoiceHistory(invoice.ownerId);
      loadBillableEvents().then((events) => renderAccountHistory(invoice.ownerId, events));
    }
  } catch (err) {
    invoice.paid = prev;
    showToast("Couldn't update: " + err.message, true);
  }
}

// Settles a single unbilled session outside the invoice system (e.g. paid
// cash in person) — it disappears from "Unbilled Sessions" and shows up in
// the Account History below as Paid, with no invoice ever generated.
async function markSessionPaidNoInvoice(evt, ownerId) {
  try {
    await markEventsDirectPaid([evt]);
    await loadBillableEvents(true);
    showToast("Marked paid — moved to account history");
    if (state.currentAccountOwnerId === ownerId) renderAccountProfile(ownerId);
  } catch (err) {
    showToast("Couldn't update: " + err.message, true);
  }
}

// Reverts a mistaken "Mark Paid (no invoice)" — moves the session back to
// Unbilled Sessions.
async function undoMarkPaidNoInvoice(eventId, ownerId, events) {
  const evt = (events || []).find((e) => e.id === eventId);
  if (!evt) { showToast("Couldn't find that session.", true); return; }
  try {
    const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
    const newProps = Object.assign({}, props, { directPaid: "false" });
    await calendarPatchEvent(evt.id, { extendedProperties: { private: newProps } });
    await loadBillableEvents(true);
    showToast("Moved back to unbilled");
    if (state.currentAccountOwnerId === ownerId) renderAccountProfile(ownerId);
  } catch (err) {
    showToast("Couldn't update: " + err.message, true);
  }
}

function monthKeyFromDateStr(dateStr) {
  return (dateStr || "").slice(0, 7); // "YYYY-MM"
}

function monthLabelFromKey(key) {
  const parts = key.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!y || !m) return key || "Unknown month";
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

// Itemized ledger for the account, grouped by month, covering every
// session and fee regardless of whether it was ever invoiced — so nothing
// falls through the cracks between "unbilled," "paid directly," and
// "invoiced" bookkeeping.
function renderAccountHistory(ownerId, events) {
  const container = $("#accountHistoryList");
  if (!container) return;
  container.innerHTML = "";

  const owner = state.db.owners.find((o) => o.id === ownerId);
  const rate = owner ? effectiveRate(owner) : 0;
  const entries = [];

  allEventsForAccount(events, ownerId).forEach((evt) => {
    entries.push({
      date: eventDateStr(evt),
      label: eventBillingLabel(evt),
      amount: rate,
      status: eventStatus(evt),
      eventId: evt.id,
    });
  });

  state.db.invoices
    .filter((inv) => inv.ownerId === ownerId)
    .forEach((inv) => {
      (inv.lineItems || [])
        .filter((li) => !li.eventId) // session line items are already covered via the event above
        .forEach((li) => {
          entries.push({
            date: li.date || inv.date,
            label: li.label,
            amount: Number(li.amount) || 0,
            status: inv.paid ? "invoiced_paid" : "invoiced_unpaid",
          });
        });
    });

  if (!entries.length) {
    container.appendChild(el("p", { class: "empty-note" }, "No billing history yet."));
    return;
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));
  const groups = {};
  entries.forEach((e) => {
    const key = monthKeyFromDateStr(e.date);
    (groups[key] = groups[key] || []).push(e);
  });

  Object.keys(groups)
    .sort()
    .reverse()
    .forEach((key) => {
      const items = groups[key];
      const subtotal = items.reduce((sum, e) => sum + e.amount, 0);
      const monthBlock = el("div", { class: "history-month" });
      monthBlock.appendChild(
        el(
          "div",
          { class: "report-card-head" },
          el("h4", { style: "margin: 0;" }, monthLabelFromKey(key)),
          el("span", { class: "muted small" }, "$" + subtotal.toFixed(2))
        )
      );
      const ul = el("ul", { class: "history-item-list" });
      items.forEach((e) => {
        ul.appendChild(
          el(
            "li",
            { class: "history-item" },
            el("span", {}, fmtDateShort(e.date) + " — " + e.label + " — $" + e.amount.toFixed(2)),
            el(
              "span",
              { style: "display: flex; align-items: center; gap: 6px;" },
              el("span", { class: "badge " + STATUS_BADGE_CLASS[e.status] }, STATUS_LABELS[e.status]),
              e.status === "paid_direct"
                ? el("button", { type: "button", class: "btn btn-ghost small", onclick: () => undoMarkPaidNoInvoice(e.eventId, ownerId, events) }, "Undo")
                : null
            )
          )
        );
      });
      monthBlock.appendChild(ul);
      container.appendChild(monthBlock);
    });
}

function renderReportCards(horseId) {
  const list = $("#reportCardList");
  list.innerHTML = "";
  const cards = state.db.reportCards
    .filter((c) => c.horseId === horseId)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  if (!cards.length) {
    list.appendChild(el("p", { class: "empty-note" }, "No report cards logged yet."));
    return;
  }

  cards.forEach((c) => {
    const horse = state.db.horses.find((h) => h.id === horseId);
    const card = el("div", { class: "report-card" });
    card.appendChild(
      el(
        "div",
        { class: "report-card-head" },
        el("div", { class: "report-card-date" }, fmtDateHuman(c.date)),
        el("div", { class: "report-card-rider" }, "Rider: " + escapeHtml(c.rider))
      )
    );
    card.appendChild(el("div", { class: "report-card-summary" }, c.summary));
    if (c.exercises) card.appendChild(el("p", { class: "muted small" }, "Exercises: " + c.exercises));

    if (c.media && c.media.length) {
      const thumbWrap = el("div", { class: "media-thumbs" });
      c.media.forEach((m) => {
        const isImg = (m.mimeType || "").startsWith("image/");
        const thumb = el(
          "a",
          { class: "media-thumb", href: m.webViewLink, target: "_blank", rel: "noopener" },
          isImg && m.fileId ? mediaThumbImg(m.fileId, 200) : document.createTextNode(m.mimeType && m.mimeType.startsWith("video/") ? "🎥 video" : "📎 file")
        );
        thumbWrap.appendChild(thumb);
      });
      card.appendChild(thumbWrap);
    }

    const actions = el("div", { class: "profile-actions" });
    const cardOwner = horse ? ownerForHorse(horse) : null;
    if (cardOwner && cardOwner.email) {
      actions.appendChild(
        el(
          "button",
          { class: "btn btn-ghost small", onclick: (e) => emailReportCardToOwner(horse, c, e.currentTarget) },
          "Email to Owner"
        )
      );
    }
    if (cardOwner && cardOwner.phone) {
      actions.appendChild(
        el(
          "button",
          { class: "btn btn-ghost small", onclick: () => textReportCardToOwner(horse, c) },
          "Text to Owner"
        )
      );
    }
    actions.appendChild(
      el("button", { class: "btn btn-ghost small", onclick: () => openReportCardModal(horseId, c.date, c) }, "Edit")
    );
    actions.appendChild(
      el("button", { class: "btn btn-danger small", onclick: () => deleteReportCard(horseId, c.id) }, "Delete")
    );
    card.appendChild(actions);

    list.appendChild(card);
  });
}

async function deleteReportCard(horseId, cardId) {
  if (!confirm("Delete this report card? This can't be undone.")) return;
  const idx = state.db.reportCards.findIndex((c) => c.id === cardId);
  if (idx === -1) return;
  const removed = state.db.reportCards[idx];
  state.db.reportCards.splice(idx, 1);
  try {
    await saveDb();
    showToast("Report card deleted");
    renderReportCards(horseId);
  } catch (err) {
    state.db.reportCards.splice(idx, 0, removed);
    showToast("Couldn't delete report card: " + err.message, true);
  }
}

function textReportCardToOwner(horse, card) {
  const owner = ownerForHorse(horse);
  const info = owner ? accountContactInfo(owner) : null;
  if (!info || !info.phone) { showToast("No owner phone on file.", true); return; }
  let body = `${horse.name} update (${fmtDateHuman(card.date)}): ${card.summary}`;
  if (card.exercises) body += ` Exercises: ${card.exercises}`;
  body += ` — RPD Equestrian`;
  const phone = info.phone.replace(/[^\d+]/g, "");
  window.location.href = `sms:${phone}?body=${encodeURIComponent(body)}`;
}

async function emailReportCardToOwner(horse, card, btn) {
  const owner = ownerForHorse(horse);
  const info = owner ? accountContactInfo(owner) : null;
  if (!info || !info.email) { showToast("No owner email on file.", true); return; }
  const origText = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

  const subject = `Work Report for ${horse.name} — ${fmtDateHuman(card.date)}`;
  let baseBody = `Hi ${info.name || ""},\n\nHere's what ${horse.name} worked on:\n\n${card.summary}\n`;
  if (card.exercises) baseBody += `\nExercises/notes: ${card.exercises}\n`;
  baseBody += `\nRidden by: ${card.rider}\n`;

  try {
    let attachments = [];
    let unattached = [];
    if (card.media && card.media.length) {
      const prepared = await prepareEmailAttachments(card.media);
      attachments = prepared.attachments;
      unattached = prepared.unattached;
    }
    let bodyText = baseBody;
    if (unattached.length) {
      const links = unattached.map((m) => m.webViewLink).filter(Boolean);
      if (links.length) bodyText += `\nAdditional photos/videos:\n` + links.join("\n") + "\n";
    }
    bodyText += `\n— RPD Equestrian`;

    await gmailSendEmail({ to: info.email, subject, bodyText, attachments });
    showToast(attachments.length ? `Email sent with ${attachments.length} attachment(s).` : "Email sent.");
  } catch (err) {
    console.warn("Gmail send failed, falling back to mailto", err);
    if (/insufficient|scope|permission|403/i.test(err.message || "")) {
      showToast("Need permission to send email with attachments — please re-authorize, then try again.", true);
      requestSignIn(true);
    } else {
      showToast("Couldn't send email automatically, opening your email app instead.", true);
    }
    let fallbackBody = baseBody;
    if (card.media && card.media.length) {
      const links = card.media.map((m) => m.webViewLink).filter(Boolean);
      if (links.length) fallbackBody += `\nPhotos/Videos:\n` + links.join("\n") + "\n";
    }
    fallbackBody += `\n— RPD Equestrian`;
    window.location.href = `mailto:${encodeURIComponent(info.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fallbackBody)}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText || "Email to Owner"; }
  }
}

/* ---- Add / Edit Report Card modal ---- */
function openReportCardModal(horseId, defaultDate, editCard, scheduleDefaults) {
  state.currentHorseId = horseId;
  state.editingReportCardId = editCard ? editCard.id : null;
  $("#reportCardModalTitle").textContent = editCard ? "Edit Report Card" : "New Report Card";
  $("#rcSubmitBtn").textContent = editCard ? "Update Report Card" : "Save Report Card";
  $("#rcDate").value = editCard ? editCard.date : (defaultDate || todayStr());
  $("#rcRider").value = editCard ? editCard.rider : ((scheduleDefaults && scheduleDefaults.rider) || "Shariti");
  $("#rcSummary").value = editCard ? editCard.summary : "";
  $("#rcExercises").value = editCard ? editCard.exercises : ((scheduleDefaults && scheduleDefaults.notes) || "");
  $("#rcMedia").value = "";
  $("#rcUploadStatus").textContent = editCard && editCard.media && editCard.media.length
    ? `${editCard.media.length} file(s) already attached — choosing new files will add more.`
    : "";
  openModal("reportCardModal");
}

$("#addReportCardBtn").addEventListener("click", () => openReportCardModal(state.currentHorseId, todayStr(), null));

$("#reportCardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const horseId = state.currentHorseId;
  const horse = state.db.horses.find((h) => h.id === horseId);
  if (!horse) { showToast("No horse selected.", true); return; }

  const submitBtn = $("#rcSubmitBtn");
  submitBtn.disabled = true;
  const statusEl = $("#rcUploadStatus");
  const editingId = state.editingReportCardId;
  const existingCard = editingId ? state.db.reportCards.find((c) => c.id === editingId) : null;

  try {
    const files = Array.from($("#rcMedia").files || []);
    const media = existingCard && existingCard.media ? existingCard.media.slice() : [];
    if (files.length) {
      const horseMediaFolder = await driveFindOrCreateFolder(`${horse.name}-${horse.id}`, state.mediaFolderId);
      for (let i = 0; i < files.length; i++) {
        statusEl.textContent = `Uploading ${i + 1} of ${files.length}…`;
        const uploaded = await driveUploadMedia(files[i], horseMediaFolder.id);
        media.push({
          fileId: uploaded.id,
          name: uploaded.name,
          mimeType: uploaded.mimeType,
          webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
          thumbnailLink: uploaded.thumbnailLink || "",
        });
      }
    }
    statusEl.textContent = editingId ? "Updating report card…" : "Saving report card…";

    const cardData = {
      horseId,
      date: $("#rcDate").value,
      rider: $("#rcRider").value,
      summary: $("#rcSummary").value.trim(),
      exercises: $("#rcExercises").value.trim(),
      media,
    };

    if (editingId && existingCard) {
      Object.assign(existingCard, cardData);
    } else {
      state.db.reportCards.push(Object.assign({ id: uuid(), createdAt: new Date().toISOString() }, cardData));
    }
    await saveDb();

    closeModal("reportCardModal");
    showToast(editingId ? "Report card updated" : "Report card saved");
    state.editingReportCardId = null;
    renderReportCards(horseId);
  } catch (err) {
    showToast("Couldn't save report card: " + err.message, true);
  } finally {
    submitBtn.disabled = false;
    statusEl.textContent = "";
  }
});

/* =========================================================
   STUDENTS VIEW
   ========================================================= */
function renderStudents() {
  const grid = $("#studentsGrid");
  grid.innerHTML = "";
  let students = state.db.students.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (state.studentFilter === "active") students = students.filter((s) => s.active);
  else if (state.studentFilter === "inactive") students = students.filter((s) => !s.active);

  if (!students.length) {
    grid.appendChild(el("p", { class: "empty-note" }, "No students to show yet."));
    return;
  }

  students.forEach((s) => {
    const programLine = s.programDaysPerWeek ? `${s.programDaysPerWeek}x/week` + (s.programNotes ? " · " + s.programNotes : "") : (s.programNotes || "");
    const card = el(
      "div",
      { class: "horse-card" + (s.active ? "" : " inactive"), onclick: () => navigate("student-profile", s.id) },
      el("div", { class: "horse-card-top" }, avatarEl(s), el("h3", {}, s.name)),
      el("span", { class: "badge" + (s.active ? "" : " inactive") }, s.active ? "Active" : "Inactive"),
      el("p", { class: "muted small" }, s.contactPhone || s.contactEmail || " "),
      programLine ? el("p", { class: "muted small" }, "Program: " + programLine) : null
    );
    grid.appendChild(card);
  });
}

document.querySelectorAll(".student-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".student-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.studentFilter = btn.dataset.filter;
    renderStudents();
  });
});

/* ---- Add / Edit Student modal ---- */
function openStudentModal(student) {
  $("#studentModalTitle").textContent = student ? "Edit Student" : "Add Student";
  $("#studentId").value = student ? student.id : "";
  $("#studentName").value = student ? student.name : "";
  $("#studentPhone").value = student ? student.contactPhone || "" : "";
  $("#studentEmail").value = student ? student.contactEmail || "" : "";
  $("#studentGuardian").value = student ? student.guardianName || "" : "";
  $("#studentProgramDays").value = student && student.programDaysPerWeek != null ? student.programDaysPerWeek : "";
  $("#studentProgramNotes").value = student ? student.programNotes || "" : "";
  $("#studentNotes").value = student ? student.notes || "" : "";
  $("#studentActive").checked = student ? !!student.active : true;
  $("#studentPhoto").value = "";

  const previewWrap = $("#studentPhotoPreviewWrap");
  if (student && student.photo && student.photo.fileId) {
    $("#studentPhotoPreview").src = driveThumbUrl(student.photo.fileId, 200);
    previewWrap.hidden = false;
  } else {
    previewWrap.hidden = true;
  }

  openModal("studentModal");
}

$("#addStudentBtn").addEventListener("click", () => openStudentModal(null));

$("#studentForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#studentId").value || uuid();
  const isNew = !$("#studentId").value;
  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    let photo = null;
    if (!isNew) {
      const existing = state.db.students.find((s) => s.id === id);
      photo = existing ? existing.photo || null : null;
    }
    const photoFile = $("#studentPhoto").files[0];
    if (photoFile) {
      submitBtn.textContent = "Uploading photo…";
      const uploaded = await driveUploadMedia(photoFile, state.profilesFolderId);
      photo = {
        fileId: uploaded.id,
        mimeType: uploaded.mimeType,
        webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
        thumbnailLink: uploaded.thumbnailLink || "",
      };
    }

    const studentData = {
      id,
      name: $("#studentName").value.trim(),
      contactPhone: $("#studentPhone").value.trim(),
      contactEmail: $("#studentEmail").value.trim(),
      guardianName: $("#studentGuardian").value.trim(),
      programDaysPerWeek: $("#studentProgramDays").value ? Number($("#studentProgramDays").value) : null,
      programNotes: $("#studentProgramNotes").value.trim(),
      notes: $("#studentNotes").value.trim(),
      active: $("#studentActive").checked,
      photo,
      createdAt: isNew ? new Date().toISOString() : undefined,
    };

    if (isNew) {
      state.db.students.push(studentData);
    } else {
      const idx = state.db.students.findIndex((s) => s.id === id);
      state.db.students[idx] = Object.assign({}, state.db.students[idx], studentData, {
        createdAt: state.db.students[idx].createdAt,
      });
    }
    await saveDb();
    closeModal("studentModal");
    showToast(isNew ? "Student added" : "Student updated");
    if (state.currentView === "student-profile") renderStudentProfile(id);
    else renderStudents();
  } catch (err) {
    showToast("Couldn't save student: " + err.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Save Student";
  }
});

/* =========================================================
   STUDENT PROFILE VIEW
   ========================================================= */
$("#backToStudentsBtn").addEventListener("click", () => navigate("students"));

function renderStudentProfile(studentId) {
  const student = state.db.students.find((s) => s.id === studentId);
  const header = $("#studentProfileHeader");
  if (!student) {
    header.innerHTML = "<p>Student not found.</p>";
    return;
  }
  header.innerHTML = "";
  header.appendChild(
    el(
      "div",
      { class: "profile-title-row" },
      avatarEl(student, "large"),
      el(
        "div",
        {},
        el("h1", {}, student.name),
        el("span", { class: "badge" + (student.active ? "" : " inactive") }, student.active ? "Active student" : "Inactive")
      )
    )
  );
  header.appendChild(
    el(
      "div",
      { class: "profile-meta" },
      student.contactPhone ? el("span", {}, "Phone: " + escapeHtml(student.contactPhone)) : null,
      student.contactEmail ? el("span", {}, escapeHtml(student.contactEmail)) : null,
      student.guardianName ? el("span", {}, "Guardian: " + escapeHtml(student.guardianName)) : null,
      student.programDaysPerWeek ? el("span", {}, "Program: " + student.programDaysPerWeek + "x/week" + (student.programNotes ? " (" + escapeHtml(student.programNotes) + ")" : "")) : null,
      el("span", { class: "agenda-name-link", onclick: () => navigate("account-profile", accountIdForStudent(student.id)) }, "View Account")
    )
  );
  if (student.notes) header.appendChild(el("p", { class: "muted" }, student.notes));

  header.appendChild(
    el(
      "div",
      { class: "profile-actions" },
      el("button", { class: "btn btn-ghost small", onclick: () => openStudentModal(student) }, "Edit Info"),
      el(
        "button",
        { class: "btn btn-ghost small", onclick: () => toggleStudentActive(student) },
        student.active ? "Mark Inactive" : "Mark Active"
      ),
      el("button", { class: "btn btn-danger small", onclick: () => deleteStudent(student) }, "Delete Student")
    )
  );

  renderWeekStrip("#studentWeekSchedule", "studentId", studentId);
  renderLessonLogs(studentId);
}

async function toggleStudentActive(student) {
  student.active = !student.active;
  try {
    await saveDb();
    showToast(student.active ? "Marked active" : "Marked inactive");
    renderStudentProfile(student.id);
  } catch (err) {
    student.active = !student.active;
    showToast("Couldn't update: " + err.message, true);
  }
}

async function deleteStudent(student) {
  const ok = confirm(
    `Delete ${student.name}? This also deletes their lesson log history in the app.\n\nCalendar lessons and uploaded photos will NOT be deleted automatically — remove those separately if you want them gone too.\n\nThis can't be undone.`
  );
  if (!ok) return;

  const studentIdx = state.db.students.findIndex((s) => s.id === student.id);
  const removedStudent = state.db.students[studentIdx];
  const removedLogs = state.db.lessonLogs.filter((l) => l.studentId === student.id);
  state.db.students = state.db.students.filter((s) => s.id !== student.id);
  state.db.lessonLogs = state.db.lessonLogs.filter((l) => l.studentId !== student.id);

  try {
    await saveDb();
    showToast("Student deleted");
    navigate("students");
  } catch (err) {
    state.db.students.splice(studentIdx, 0, removedStudent);
    state.db.lessonLogs = state.db.lessonLogs.concat(removedLogs);
    showToast("Couldn't delete student: " + err.message, true);
  }
}

function renderLessonLogs(studentId) {
  const list = $("#lessonLogList");
  list.innerHTML = "";
  const logs = state.db.lessonLogs
    .filter((l) => l.studentId === studentId)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  if (!logs.length) {
    list.appendChild(el("p", { class: "empty-note" }, "No lesson logs yet."));
    return;
  }

  logs.forEach((l) => {
    const student = state.db.students.find((s) => s.id === studentId);
    const horse = l.horseId ? state.db.horses.find((h) => h.id === l.horseId) : null;
    const card = el("div", { class: "report-card" });
    card.appendChild(
      el(
        "div",
        { class: "report-card-head" },
        el("div", { class: "report-card-date" }, fmtDateHuman(l.date)),
        el("div", { class: "report-card-rider" }, "Instructor: " + escapeHtml(l.instructor) + (horse ? " · Horse: " + escapeHtml(horse.name) : ""))
      )
    );
    card.appendChild(el("div", { class: "report-card-summary" }, l.summary));
    if (l.exercises) card.appendChild(el("p", { class: "muted small" }, "Exercises: " + l.exercises));

    if (l.media && l.media.length) {
      const thumbWrap = el("div", { class: "media-thumbs" });
      l.media.forEach((m) => {
        const isImg = (m.mimeType || "").startsWith("image/");
        thumbWrap.appendChild(
          el(
            "a",
            { class: "media-thumb", href: m.webViewLink, target: "_blank", rel: "noopener" },
            isImg && m.fileId ? mediaThumbImg(m.fileId, 200) : document.createTextNode(m.mimeType && m.mimeType.startsWith("video/") ? "🎥 video" : "📎 file")
          )
        );
      });
      card.appendChild(thumbWrap);
    }

    const actions = el("div", { class: "profile-actions" });
    if (student && student.contactEmail) {
      actions.appendChild(
        el("button", { class: "btn btn-ghost small", onclick: (e) => emailLessonLogToFamily(student, l, horse, e.currentTarget) }, "Email to Family")
      );
    }
    if (student && student.contactPhone) {
      actions.appendChild(
        el("button", { class: "btn btn-ghost small", onclick: () => textLessonLogToFamily(student, l, horse) }, "Text to Family")
      );
    }
    actions.appendChild(
      el("button", { class: "btn btn-ghost small", onclick: () => openLessonLogModal(studentId, l.horseId || "", l.date, l) }, "Edit")
    );
    actions.appendChild(
      el("button", { class: "btn btn-danger small", onclick: () => deleteLessonLog(studentId, l.id) }, "Delete")
    );
    card.appendChild(actions);

    list.appendChild(card);
  });
}

async function deleteLessonLog(studentId, logId) {
  if (!confirm("Delete this lesson log? This can't be undone.")) return;
  const idx = state.db.lessonLogs.findIndex((l) => l.id === logId);
  if (idx === -1) return;
  const removed = state.db.lessonLogs[idx];
  state.db.lessonLogs.splice(idx, 1);
  try {
    await saveDb();
    showToast("Lesson log deleted");
    renderLessonLogs(studentId);
  } catch (err) {
    state.db.lessonLogs.splice(idx, 0, removed);
    showToast("Couldn't delete lesson log: " + err.message, true);
  }
}

function textLessonLogToFamily(student, log, horse) {
  let body = `${student.name} lesson update (${fmtDateHuman(log.date)}): ${log.summary}`;
  if (log.exercises) body += ` Exercises: ${log.exercises}`;
  body += ` — RPD Equestrian`;
  const phone = student.contactPhone.replace(/[^\d+]/g, "");
  window.location.href = `sms:${phone}?body=${encodeURIComponent(body)}`;
}

async function emailLessonLogToFamily(student, log, horse, btn) {
  if (!student.contactEmail) { showToast("No family email on file.", true); return; }
  const origText = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }

  const subject = `Lesson Report for ${student.name} — ${fmtDateHuman(log.date)}`;
  let baseBody = `Hi${student.guardianName ? " " + student.guardianName : ""},\n\nHere's what ${student.name} worked on${horse ? " on " + horse.name : ""}:\n\n${log.summary}\n`;
  if (log.exercises) baseBody += `\nExercises/notes: ${log.exercises}\n`;
  baseBody += `\nInstructor: ${log.instructor}\n`;

  try {
    let attachments = [];
    let unattached = [];
    if (log.media && log.media.length) {
      const prepared = await prepareEmailAttachments(log.media);
      attachments = prepared.attachments;
      unattached = prepared.unattached;
    }
    let bodyText = baseBody;
    if (unattached.length) {
      const links = unattached.map((m) => m.webViewLink).filter(Boolean);
      if (links.length) bodyText += `\nAdditional photos/videos:\n` + links.join("\n") + "\n";
    }
    bodyText += `\n— RPD Equestrian`;

    await gmailSendEmail({ to: student.contactEmail, subject, bodyText, attachments });
    showToast(attachments.length ? `Email sent with ${attachments.length} attachment(s).` : "Email sent.");
  } catch (err) {
    console.warn("Gmail send failed, falling back to mailto", err);
    if (/insufficient|scope|permission|403/i.test(err.message || "")) {
      showToast("Need permission to send email with attachments — please re-authorize, then try again.", true);
      requestSignIn(true);
    } else {
      showToast("Couldn't send email automatically, opening your email app instead.", true);
    }
    let fallbackBody = baseBody;
    if (log.media && log.media.length) {
      const links = log.media.map((m) => m.webViewLink).filter(Boolean);
      if (links.length) fallbackBody += `\nPhotos/Videos:\n` + links.join("\n") + "\n";
    }
    fallbackBody += `\n— RPD Equestrian`;
    window.location.href = `mailto:${encodeURIComponent(student.contactEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(fallbackBody)}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText || "Email to Family"; }
  }
}

/* ---- Add / Edit Lesson Log modal ---- */
function openLessonLogModal(studentId, horseId, defaultDate, editLog, scheduleDefaults) {
  state.currentStudentId = studentId;
  state.editingLessonLogId = editLog ? editLog.id : null;
  $("#lessonLogModalTitle").textContent = editLog ? "Edit Lesson Log" : "New Lesson Log";
  $("#llSubmitBtn").textContent = editLog ? "Update Lesson Log" : "Save Lesson Log";
  $("#llDate").value = editLog ? editLog.date : (defaultDate || todayStr());
  $("#llInstructor").value = editLog ? editLog.instructor : ((scheduleDefaults && scheduleDefaults.instructor) || "Laken");

  const horseSelect = $("#llHorse");
  horseSelect.innerHTML = "";
  horseSelect.appendChild(el("option", { value: "" }, "— none / not specified —"));
  state.db.horses.filter((h) => h.active).forEach((h) => horseSelect.appendChild(el("option", { value: h.id }, h.name)));
  horseSelect.value = editLog ? (editLog.horseId || "") : (horseId || "");

  $("#llSummary").value = editLog ? editLog.summary : "";
  $("#llExercises").value = editLog ? editLog.exercises : ((scheduleDefaults && scheduleDefaults.notes) || "");
  $("#llMedia").value = "";
  $("#llUploadStatus").textContent = editLog && editLog.media && editLog.media.length
    ? `${editLog.media.length} file(s) already attached — choosing new files will add more.`
    : "";
  openModal("lessonLogModal");
}

$("#addLessonLogBtn").addEventListener("click", () => openLessonLogModal(state.currentStudentId, "", todayStr(), null));

$("#lessonLogForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const studentId = state.currentStudentId;
  const student = state.db.students.find((s) => s.id === studentId);
  if (!student) { showToast("No student selected.", true); return; }

  const submitBtn = $("#llSubmitBtn");
  submitBtn.disabled = true;
  const statusEl = $("#llUploadStatus");
  const editingId = state.editingLessonLogId;
  const existingLog = editingId ? state.db.lessonLogs.find((l) => l.id === editingId) : null;

  try {
    const files = Array.from($("#llMedia").files || []);
    const media = existingLog && existingLog.media ? existingLog.media.slice() : [];
    if (files.length) {
      const studentMediaFolder = await driveFindOrCreateFolder(`${student.name}-${student.id}-lessons`, state.mediaFolderId);
      for (let i = 0; i < files.length; i++) {
        statusEl.textContent = `Uploading ${i + 1} of ${files.length}…`;
        const uploaded = await driveUploadMedia(files[i], studentMediaFolder.id);
        media.push({
          fileId: uploaded.id,
          name: uploaded.name,
          mimeType: uploaded.mimeType,
          webViewLink: uploaded.webViewLink || `https://drive.google.com/file/d/${uploaded.id}/view`,
          thumbnailLink: uploaded.thumbnailLink || "",
        });
      }
    }
    statusEl.textContent = editingId ? "Updating lesson log…" : "Saving lesson log…";

    const logData = {
      studentId,
      horseId: $("#llHorse").value || null,
      date: $("#llDate").value,
      instructor: $("#llInstructor").value,
      summary: $("#llSummary").value.trim(),
      exercises: $("#llExercises").value.trim(),
      media,
    };

    if (editingId && existingLog) {
      Object.assign(existingLog, logData);
    } else {
      state.db.lessonLogs.push(Object.assign({ id: uuid(), createdAt: new Date().toISOString() }, logData));
    }
    await saveDb();

    closeModal("lessonLogModal");
    showToast(editingId ? "Lesson log updated" : "Lesson log saved");
    state.editingLessonLogId = null;
    renderLessonLogs(studentId);
  } catch (err) {
    showToast("Couldn't save lesson log: " + err.message, true);
  } finally {
    submitBtn.disabled = false;
    statusEl.textContent = "";
  }
});

/* =========================================================
   MODAL HELPERS
   ========================================================= */
function openModal(id) { $("#" + id).hidden = false; }
function closeModal(id) { $("#" + id).hidden = true; }

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
});

/* =========================================================
   INIT
   ========================================================= */
window.addEventListener("load", () => {
  const check = setInterval(() => {
    if (window.google && google.accounts && google.accounts.oauth2) {
      clearInterval(check);
      initAuth();
    }
  }, 50);
});
