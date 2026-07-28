/* =========================================================
   RPD EQUESTRIAN — Barn schedule & horse tracking app
   Static, client-side only. Talks directly to Google Calendar
   & Google Drive APIs using the signed-in user's OAuth token.
   ========================================================= */

/* ---------------- CONFIG ---------------- */
const CONFIG = {
  CLIENT_ID: "288317276128-d94db2aofp0it4glcsscbm4jaq7go01j.apps.googleusercontent.com",
  CALENDAR_ID: "8920f5279f3d5f19d97bb40abcf840dcbec4f15c8e1467a2be6b0b61734f2d6f@group.calendar.google.com",
  CALENDAR_EMBED_SRC: "https://calendar.google.com/calendar/embed?src=8920f5279f3d5f19d97bb40abcf840dcbec4f15c8e1467a2be6b0b61734f2d6f%40group.calendar.google.com&ctz=America%2FNew_York",
  SCOPES: "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive",
  APP_FOLDER_NAME: "RPD Equestrian Data",
  MEDIA_FOLDER_NAME: "Media",
  DB_FILE_NAME: "database.json",
  TIMEZONE: "America/New_York",
};

/* ---------------- STATE ---------------- */
const state = {
  accessToken: null,
  tokenExpiresAt: 0,
  tokenClient: null,
  appFolderId: null,
  mediaFolderId: null,
  dbFileId: null,
  db: { horses: [], reportCards: [] },
  currentView: "schedule",
  currentHorseId: null,
  horseFilter: "active",
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

function fmtDateHuman(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function fmtTimeHuman(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/* ---------------- VIEW SWITCHING ---------------- */
function showOnly(id) {
  ["signedOutView", "loadingView", "errorView", "scheduleView", "horsesView", "horseProfileView"].forEach((v) => {
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
   AUTH
   ========================================================= */
function initAuth() {
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        setError("Sign-in was cancelled or failed: " + resp.error);
        return;
      }
      state.accessToken = resp.access_token;
      state.tokenExpiresAt = Date.now() + (resp.expires_in || 3500) * 1000;
      sessionStorage.setItem("rpd_token", state.accessToken);
      sessionStorage.setItem("rpd_token_exp", String(state.tokenExpiresAt));
      onSignedIn();
    },
  });

  // Try to resume a session-stored token
  const savedToken = sessionStorage.getItem("rpd_token");
  const savedExp = Number(sessionStorage.getItem("rpd_token_exp") || 0);
  if (savedToken && savedExp > Date.now() + 60000) {
    state.accessToken = savedToken;
    state.tokenExpiresAt = savedExp;
    onSignedIn();
  }

  $("#signInBtn").addEventListener("click", requestSignIn);
  $("#signInBtn2").addEventListener("click", requestSignIn);
  $("#signOutBtn").addEventListener("click", signOut);
}

function requestSignIn() {
  state.tokenClient.requestAccessToken({ prompt: state.accessToken ? "" : "consent" });
}

function signOut() {
  if (state.accessToken) {
    google.accounts.oauth2.revoke(state.accessToken, () => {});
  }
  sessionStorage.removeItem("rpd_token");
  sessionStorage.removeItem("rpd_token_exp");
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
async function apiFetch(url, options = {}) {
  if (!state.accessToken) throw new Error("Not signed in");
  const headers = Object.assign({}, options.headers, {
    Authorization: "Bearer " + state.accessToken,
  });
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
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

async function driveUploadMedia(file, parentId, onProgress) {
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

  // Make it viewable via link so it can be shared with owners / shown as thumbnail
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
async function calendarListEvents(timeMinISO, timeMaxISO) {
  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CONFIG.CALENDAR_ID)}/events` +
    `?timeMin=${encodeURIComponent(timeMinISO)}&timeMax=${encodeURIComponent(timeMaxISO)}` +
    `&singleEvents=true&orderBy=startTime&maxResults=250`;
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

/* =========================================================
   BOOTSTRAP — find/create Drive folder + database.json
   ========================================================= */
async function bootstrapData() {
  setLoading("Connecting to Google Drive…");
  try {
    const appFolder = await driveFindOrCreateFolder(CONFIG.APP_FOLDER_NAME, null);
    state.appFolderId = appFolder.id;

    const mediaFolder = await driveFindOrCreateFolder(CONFIG.MEDIA_FOLDER_NAME, state.appFolderId);
    state.mediaFolderId = mediaFolder.id;

    const q = `name='${CONFIG.DB_FILE_NAME}' and '${state.appFolderId}' in parents and trashed=false`;
    let dbFile = await driveFindOne(q);
    if (!dbFile) {
      dbFile = await driveCreateJsonFile(CONFIG.DB_FILE_NAME, state.appFolderId, { horses: [], reportCards: [] });
    }
    state.dbFileId = dbFile.id;

    setLoading("Loading horses & report cards…");
    state.db = await driveGetJson(state.dbFileId);
    if (!state.db.horses) state.db.horses = [];
    if (!state.db.reportCards) state.db.reportCards = [];

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
  }
}

document.querySelectorAll(".nav-link").forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.dataset.route));
});

/* =========================================================
   SCHEDULE VIEW
   ========================================================= */
async function renderSchedule() {
  const list = $("#agendaList");
  list.innerHTML = "<p class='muted'>Loading schedule…</p>";
  try {
    const now = new Date();
    const timeMin = new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + 21 * 24 * 3600 * 1000).toISOString();
    const events = await calendarListEvents(timeMin, timeMax);
    renderAgenda(events);
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("p", { class: "empty-note" }, "Could not load the schedule: " + err.message));
  }
}

function renderAgenda(events) {
  const list = $("#agendaList");
  list.innerHTML = "";
  if (!events.length) {
    list.appendChild(el("p", { class: "empty-note" }, "No work sessions scheduled. Click “+ Add Work Session” to get started."));
    return;
  }
  const byDay = {};
  events.forEach((evt) => {
    const startIso = evt.start.dateTime || evt.start.date;
    const dayKey = startIso.slice(0, 10);
    (byDay[dayKey] = byDay[dayKey] || []).push(evt);
  });

  Object.keys(byDay).sort().forEach((day) => {
    const dayCard = el("div", { class: "agenda-day" });
    dayCard.appendChild(el("div", { class: "agenda-day-header" }, fmtDateHuman(day) + (day === todayStr() ? " — Today" : "")));
    byDay[day].forEach((evt) => {
      const props = (evt.extendedProperties && evt.extendedProperties.private) || {};
      const horse = state.db.horses.find((h) => h.id === props.horseId);
      const horseName = horse ? horse.name : props.horseName || evt.summary || "Session";
      const rider = props.rider || "";
      const time = evt.start.dateTime ? fmtTimeHuman(evt.start.dateTime) : "All day";

      const row = el(
        "div",
        { class: "agenda-row" },
        el("div", { class: "agenda-time" }, time),
        el(
          "div",
          { class: "agenda-info" },
          el("div", { class: "agenda-horse" }, horseName),
          el("div", { class: "agenda-rider" }, rider ? "Rider: " + rider : "")
        ),
        el(
          "div",
          { class: "agenda-actions" },
          el("button", {
            class: "btn btn-ghost small",
            onclick: () => {
              if (horse) openReportCardModal(horse.id, day);
              else showToast("This session isn't linked to a horse profile.", true);
            },
          }, "Log Report Card"),
          el("button", {
            class: "btn btn-ghost small",
            onclick: () => deleteSession(evt.id),
          }, "Cancel")
        )
      );
      dayCard.appendChild(row);
    });
    list.appendChild(dayCard);
  });
}

async function deleteSession(eventId) {
  if (!confirm("Remove this work session from the schedule?")) return;
  try {
    await calendarDeleteEvent(eventId);
    showToast("Session removed");
    renderSchedule();
  } catch (err) {
    showToast("Couldn't remove session: " + err.message, true);
  }
}

$("#toggleEmbedBtn").addEventListener("click", () => {
  const wrap = $("#calendarEmbedWrap");
  wrap.hidden = !wrap.hidden;
  $("#toggleEmbedBtn").textContent = wrap.hidden ? "Show full Google Calendar view ▾" : "Hide full Google Calendar view ▴";
});

/* ---- Add Work Session modal ---- */
$("#addSessionBtn").addEventListener("click", () => {
  const activeHorses = state.db.horses.filter((h) => h.active);
  const select = $("#sessionHorse");
  select.innerHTML = "";
  if (!activeHorses.length) {
    select.appendChild(el("option", { value: "" }, "No active horses — add one first"));
  }
  activeHorses.forEach((h) => select.appendChild(el("option", { value: h.id }, h.name)));
  $("#sessionDate").value = todayStr();
  $("#sessionTime").value = "09:00";
  $("#sessionNotes").value = "";
  openModal("sessionModal");
});

$("#sessionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const horseId = $("#sessionHorse").value;
  const horse = state.db.horses.find((h) => h.id === horseId);
  if (!horse) { showToast("Please add a horse first.", true); return; }
  const rider = $("#sessionRider").value;
  const date = $("#sessionDate").value;
  const time = $("#sessionTime").value;
  const notes = $("#sessionNotes").value;

  const startDateTime = `${date}T${time}:00`;
  const startDate = new Date(startDateTime);
  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
    await calendarCreateEvent({
      summary: `${horse.name} — ${rider}`,
      description: notes,
      start: { dateTime: startDate.toISOString(), timeZone: CONFIG.TIMEZONE },
      end: { dateTime: endDate.toISOString(), timeZone: CONFIG.TIMEZONE },
      extendedProperties: { private: { horseId: horse.id, horseName: horse.name, rider } },
    });
    closeModal("sessionModal");
    showToast("Added to schedule");
    renderSchedule();
  } catch (err) {
    showToast("Couldn't add session: " + err.message, true);
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
    const card = el(
      "div",
      { class: "horse-card" + (h.active ? "" : " inactive"), onclick: () => navigate("horse-profile", h.id) },
      el("h3", {}, h.name),
      el("span", { class: "badge" + (h.active ? "" : " inactive") }, h.active ? "Active" : "Inactive"),
      el("p", { class: "muted small" }, [h.breed, h.age ? h.age + " yrs" : ""].filter(Boolean).join(" · ") || " ")
    );
    grid.appendChild(card);
  });
}

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
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
  $("#horseOwnerName").value = horse ? horse.ownerName || "" : "";
  $("#horseOwnerEmail").value = horse ? horse.ownerEmail || "" : "";
  $("#horseNotes").value = horse ? horse.notes || "" : "";
  $("#horseActive").checked = horse ? !!horse.active : true;
  openModal("horseModal");
}

$("#addHorseBtn").addEventListener("click", () => openHorseModal(null));

$("#horseForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#horseId").value || uuid();
  const isNew = !$("#horseId").value;
  const horseData = {
    id,
    name: $("#horseName").value.trim(),
    breed: $("#horseBreed").value.trim(),
    age: $("#horseAge").value.trim(),
    ownerName: $("#horseOwnerName").value.trim(),
    ownerEmail: $("#horseOwnerEmail").value.trim(),
    notes: $("#horseNotes").value.trim(),
    active: $("#horseActive").checked,
    createdAt: isNew ? new Date().toISOString() : undefined,
  };
  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  try {
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
  header.appendChild(el("h1", {}, horse.name));
  header.appendChild(el("span", { class: "badge" + (horse.active ? "" : " inactive") }, horse.active ? "Active in program" : "Inactive"));
  header.appendChild(
    el(
      "div",
      { class: "profile-meta" },
      horse.breed ? el("span", {}, "Breed: " + escapeHtml(horse.breed)) : null,
      horse.age ? el("span", {}, "Age: " + escapeHtml(horse.age)) : null,
      horse.ownerName ? el("span", {}, "Owner: " + escapeHtml(horse.ownerName)) : null,
      horse.ownerEmail ? el("span", {}, escapeHtml(horse.ownerEmail)) : null
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
        {
          class: "btn btn-ghost small",
          onclick: () => toggleHorseActive(horse),
        },
        horse.active ? "Mark Inactive" : "Mark Active"
      )
    )
  );

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
          isImg && m.thumbnailLink ? el("img", { src: m.thumbnailLink }) : document.createTextNode(m.mimeType && m.mimeType.startsWith("video/") ? "🎥 video" : "📎 file")
        );
        thumbWrap.appendChild(thumb);
      });
      card.appendChild(thumbWrap);
    }

    const actions = el("div", { class: "profile-actions" });
    if (horse && horse.ownerEmail) {
      actions.appendChild(
        el(
          "button",
          {
            class: "btn btn-ghost small",
            onclick: () => emailReportCardToOwner(horse, c),
          },
          "Email to Owner"
        )
      );
    }
    card.appendChild(actions);

    list.appendChild(card);
  });
}

function emailReportCardToOwner(horse, card) {
  const subject = `Work Report for ${horse.name} — ${fmtDateHuman(card.date)}`;
  let body = `Hi ${horse.ownerName || ""},\n\nHere's what ${horse.name} worked on:\n\n${card.summary}\n`;
  if (card.exercises) body += `\nExercises/notes: ${card.exercises}\n`;
  body += `\nRidden by: ${card.rider}\n`;
  if (card.media && card.media.length) {
    body += `\nPhotos/Videos:\n` + card.media.map((m) => m.webViewLink).join("\n");
  }
  body += `\n\n— RPD Equestrian`;
  const mailto = `mailto:${encodeURIComponent(horse.ownerEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailto;
}

/* ---- Add Report Card modal ---- */
function openReportCardModal(horseId, defaultDate) {
  state.currentHorseId = horseId;
  $("#rcDate").value = defaultDate || todayStr();
  $("#rcRider").value = "Shariti";
  $("#rcSummary").value = "";
  $("#rcExercises").value = "";
  $("#rcMedia").value = "";
  $("#rcUploadStatus").textContent = "";
  openModal("reportCardModal");
}

$("#addReportCardBtn").addEventListener("click", () => openReportCardModal(state.currentHorseId, todayStr()));

$("#reportCardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const horseId = state.currentHorseId;
  const horse = state.db.horses.find((h) => h.id === horseId);
  if (!horse) { showToast("No horse selected.", true); return; }

  const submitBtn = $("#rcSubmitBtn");
  submitBtn.disabled = true;
  const statusEl = $("#rcUploadStatus");

  try {
    const files = Array.from($("#rcMedia").files || []);
    const media = [];
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
    statusEl.textContent = "Saving report card…";

    const card = {
      id: uuid(),
      horseId,
      date: $("#rcDate").value,
      rider: $("#rcRider").value,
      summary: $("#rcSummary").value.trim(),
      exercises: $("#rcExercises").value.trim(),
      media,
      createdAt: new Date().toISOString(),
    };
    state.db.reportCards.push(card);
    await saveDb();

    closeModal("reportCardModal");
    showToast("Report card saved");
    renderReportCards(horseId);
  } catch (err) {
    showToast("Couldn't save report card: " + err.message, true);
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
  // Wait for Google Identity Services script to be ready
  const check = setInterval(() => {
    if (window.google && google.accounts && google.accounts.oauth2) {
      clearInterval(check);
      initAuth();
    }
  }, 50);
});
