/* Notelume app.
   Sections: config & helpers · state · preferences · editor · persistence · note actions ·
   library · menus · sharing · shared view · banners · accounts · import/export · assistant ·
   command menu · shortcuts · toasts · wiring · boot. */
(() => {
  "use strict";

  // ---------- config ----------
  const CFG = Object.assign({
    brandName: "Notelume", tagline: "", supabaseUrl: "", supabaseAnonKey: "",
    aiEnabled: false, googleSignIn: false, contactEmail: "", passwordResetEmails: false,
  }, window.NOTELUME_CONFIG || {});
  const BRAND = CFG.brandName || "Notelume";
  const TYPES = { plain: "Plain text", rich: "Rich text", markdown: "Markdown", tasks: "Checklist" };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const NOTE_COLUMNS = "id,title,type,body,tasks,pinned,is_public,share_expires_at,share_password_hash,created_at,updated_at";
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const MOD = IS_MAC ? "⌘" : "Ctrl";
  const ALT = IS_MAC ? "⌥" : "Alt";
  // Storage keys keep the original "quillnote." prefix on purpose: renaming them would make
  // existing visitors lose their guest notes and settings.
  const KEY = {
    notes: "quillnote.notes.v1", theme: "quillnote.theme", font: "quillnote.font", size: "quillnote.size",
    sort: "quillnote.sort", lib: "quillnote.lib", guestNotice: "quillnote.guestNotice",
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const sb = (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase)
    ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;

  // Storage can be blocked (private windows, strict settings); every access is guarded.
  const store = (kind) => ({
    get(k) { try { return window[kind].getItem(k); } catch { return null; } },
    set(k, v) { try { window[kind].setItem(k, v); return true; } catch { return false; } },
    del(k) { try { window[kind].removeItem(k); } catch { /* ignore */ } },
  });
  const ls = store("localStorage"), ss = store("sessionStorage");
  const readJSON = (k, fallback) => { try { const v = JSON.parse(ls.get(k)); return v == null ? fallback : v; } catch { return fallback; } };
  const loadLocalNotes = () => { const a = readJSON(KEY.notes, []); return Array.isArray(a) ? a.filter(n => n && typeof n.id === "string") : []; };

  const newId = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (name, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- dates ----------
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  function fmtAgo(t) {
    const s = (t - Date.now()) / 1000, a = Math.abs(s);
    if (a < 45) return "just now";
    if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
    if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
    return rtf.format(Math.round(s / 86400), "day");
  }
  function listDate(t) {
    const d = new Date(t), now = new Date();
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (days === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (days === 1) return "Yesterday";
    if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  }
  const longDate = (t) => new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  // ---------- content helpers ----------
  // Inline style attributes are dropped before parsing so pasted Word or Docs content doesn't trip
  // the Content Security Policy while it's being cleaned. DOMPurify still removes anything left over.
  const STYLE_ATTR = /\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
  function sanitize(html) {
    if (window.DOMPurify) return window.DOMPurify.sanitize(String(html || "").replace(STYLE_ATTR, ""), { USE_PROFILES: { html: true }, FORBID_ATTR: ["style"] });
    // Fallback if the sanitizer failed to load: keep text only.
    const d = document.createElement("div");
    d.textContent = new DOMParser().parseFromString(String(html || ""), "text/html").body.textContent || "";
    return d.innerHTML;
  }
  // Only the editor's own classes and the checklist state survive sanitizing, so pasted or
  // shared HTML can't borrow the site's styling or smuggle other data attributes.
  if (window.DOMPurify && window.DOMPurify.addHook) {
    window.DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
      if (data.attrName === "class") {
        const keep = String(data.attrValue).split(/\s+/).filter(c => /^(tc|hl)-[a-z]+$|^checks$|^nt$/.test(c));
        if (keep.length) data.attrValue = keep.join(" "); else data.keepAttr = false;
      } else if (data.attrName.startsWith("data-") && data.attrName !== "data-checked") {
        data.keepAttr = false;
      }
    });
  }
  function mdToHtml(src) {
    if (window.marked && typeof window.marked.parse === "function") {
      try { return sanitize(window.marked.parse(String(src || ""), { gfm: true, breaks: true })); } catch { /* fall through */ }
    }
    return "<pre>" + esc(src || "") + "</pre>";
  }
  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(sanitize(html), "text/html");
    doc.querySelectorAll("br").forEach(b => b.replaceWith("\n"));
    doc.querySelectorAll("li").forEach(li => li.prepend("- "));
    doc.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr").forEach(el => el.append("\n"));
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function plainText(n) {
    if (!n) return "";
    if (n.type === "rich") return htmlToText(n.body);
    if (n.type === "tasks") return (n.tasks || []).map(t => (t.done ? "[x] " : "[ ] ") + t.text).join("\n");
    return n.body || "";
  }
  const isSharedNow = (n) => !!(n && n.isPublic && (!n.shareExpiresAt || n.shareExpiresAt > Date.now()));

  // ---------- state ----------
  const S = {
    mode: "guest", user: null, cloudReady: false, online: navigator.onLine !== false,
    notes: loadLocalNotes(),
    currentId: null, loadedAt: 0, type: "plain", tasks: [], mdView: "write",
    isExample: false, dirty: false,
    filter: "all", query: "", sort: ["updated", "created", "title"].includes(ls.get(KEY.sort)) ? ls.get(KEY.sort) : "updated",
    storageBlocked: false, guestNoticeDismissed: ss.get(KEY.guestNotice) === "off", showGuestNotice: false, notice: null,
    chat: [], chatCtl: null, shared: null, sharedId: null, viewingShared: false,
  };

  // ---------- elements ----------
  const titleEl = $("#note-title"), edPlain = $("#ed-plain"), edRich = $("#ed-rich"), mdPreview = $("#md-preview"),
        edTasks = $("#ed-tasks"), paper = $("#paper"), editorArea = $("#editor-area"), workspace = $("#workspace");

  // ---------- branding ----------
  $$("[data-brand]").forEach(el => { el.textContent = BRAND; });
  $("#kbd-k").textContent = `${MOD} K`;

  // ---------- preferences ----------
  const THEMES = ["system", "light", "dark"];
  function applyTheme(t) {
    const root = document.documentElement;
    if (t === "light" || t === "dark") root.dataset.theme = t; else delete root.dataset.theme;
    $("#theme-icon").setAttribute("href", t === "light" ? "#i-sun" : t === "dark" ? "#i-moon" : "#i-auto");
    $("#btn-theme").setAttribute("aria-label", `Theme: ${t === "system" ? "automatic" : t}. Change theme`);
    $("#btn-theme").title = `Theme: ${t === "system" ? "Automatic" : t[0].toUpperCase() + t.slice(1)}`;
  }
  let theme = THEMES.includes(ls.get(KEY.theme)) ? ls.get(KEY.theme) : "system";
  function setTheme(t, announce) {
    theme = t; ls.set(KEY.theme, t); applyTheme(t);
    if (announce) toast(`Theme: ${t === "system" ? "Automatic" : t[0].toUpperCase() + t.slice(1)}`);
  }
  function applyTypePrefs() {
    const font = ["sans", "serif", "mono"].includes(ls.get(KEY.font)) ? ls.get(KEY.font) : "sans";
    const size = ["s", "m", "l"].includes(ls.get(KEY.size)) ? ls.get(KEY.size) : "m";
    paper.dataset.font = font; paper.dataset.size = size;
    $$("#pref-font button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === font)));
    $$("#pref-size button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === size)));
    autosize();
  }

  const mqMobile = window.matchMedia("(max-width: 900px)");
  let scrim = null;
  function setLibrary(open) {
    if (mqMobile.matches) {
      document.body.classList.toggle("lib-open", open);
      if (open && !scrim) {
        scrim = document.createElement("div"); scrim.className = "scrim";
        scrim.addEventListener("click", () => setLibrary(false));
        document.body.append(scrim);
      } else if (!open && scrim) { scrim.remove(); scrim = null; }
    } else {
      document.body.classList.toggle("lib-hidden", !open);
      ls.set(KEY.lib, open ? "shown" : "hidden");
    }
    $("#btn-library").setAttribute("aria-expanded", String(open));
  }
  const libraryOpen = () => mqMobile.matches ? document.body.classList.contains("lib-open") : !document.body.classList.contains("lib-hidden");

  // ---------- editor ----------
  function autosize() {
    if (edPlain.hidden) return;
    const top = workspace.scrollTop;
    edPlain.style.height = "auto";
    edPlain.style.height = edPlain.scrollHeight + "px";
    workspace.scrollTop = top;
  }
  const renderPreview = () => { mdPreview.innerHTML = mdToHtml(edPlain.value); };
  const renderPreviewSoon = debounce(() => { if (!mdPreview.hidden) renderPreview(); }, 150);

  function showEditorFor(type) {
    S.type = type;
    const mdv = type === "markdown" ? S.mdView : "write";
    $("#rich-tools").hidden = type !== "rich";
    $("#md-tabs").hidden = type !== "markdown";
    edRich.hidden = type !== "rich";
    edTasks.hidden = type !== "tasks";
    edPlain.hidden = !(type === "plain" || (type === "markdown" && mdv !== "preview"));
    mdPreview.hidden = !(type === "markdown" && mdv !== "write");
    editorArea.classList.toggle("split", type === "markdown" && mdv === "split");
    paper.classList.toggle("wide", type === "markdown" && mdv === "split");
    $$("#md-tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.md === mdv)));
    edPlain.placeholder = type === "markdown" ? "# Heading\n\nWrite in Markdown: **bold**, _italic_, - lists, [links](https://example.com)" : "Start writing…";
    if (!mdPreview.hidden) renderPreview();
    autosize();
  }

  function loadIntoEditor(n) {
    S.mdView = "write";
    titleEl.value = n.title || "";
    edPlain.value = (n.type === "plain" || n.type === "markdown") ? (n.body || "") : "";
    edRich.innerHTML = n.type === "rich" ? sanitize(n.body) : "";
    S.tasks = n.type === "tasks" ? (n.tasks || []).map(t => ({ text: String(t.text || ""), done: !!t.done })) : [];
    showEditorFor(n.type || "plain");
    renderTasks();
    renderMeta();
  }

  function getBody() {
    if (S.type === "rich") return edRich.innerHTML;
    if (S.type === "tasks") return S.tasks.map(t => (t.done ? "[x] " : "[ ] ") + t.text).join("\n");
    return edPlain.value;
  }
  const collect = () => ({
    title: titleEl.value.trim(), type: S.type, body: getBody(),
    tasks: S.type === "tasks" ? S.tasks.map(t => ({ text: t.text, done: !!t.done })) : null,
  });
  const isEmpty = (n) => !n.title && !plainText(n).trim();
  const current = () => S.notes.find(x => x.id === S.currentId) || null;

  function renderMeta() {
    const text = plainText(collect());
    const words = (text.match(/\S+/g) || []).length;
    const bits = [`<span class="chip">${esc(TYPES[S.type])}</span>`, `${words.toLocaleString()} ${words === 1 ? "word" : "words"}`, `${text.length.toLocaleString()} characters`];
    if (words > 60) bits.push(`${Math.max(1, Math.round(words / 230))} min read`);
    const n = current();
    if (n && !S.dirty) bits.push(`Edited ${fmtAgo(n.updatedAt)}`);
    if (n && isSharedNow(n)) bits.push(`${icon(n.hasPassword ? "lock" : "globe", "i i-xs")} Shared${n.hasPassword ? " with password" : ""}`);
    $("#doc-meta").innerHTML = bits.join(" <span aria-hidden=\"true\">·</span> ");
  }

  function setSaveState(kind, text) {
    const el = $("#save-state");
    el.dataset.kind = kind;
    el.innerHTML = !text ? "" : (kind === "ok" ? icon("check") : kind === "warn" ? icon("offline") : "") + `<span class="label">${esc(text)}</span>`;
  }

  let autoT = null;
  function markDirty() {
    S.dirty = true;
    S.isExample = false;
    setSaveState("", "Edited");
    renderMeta();
    clearTimeout(autoT);
    autoT = setTimeout(() => save(false), 1200);
  }

  // ---------- checklist ----------
  function renderTasks(focusIndex) {
    const ul = $("#task-list");
    ul.textContent = "";
    S.tasks.forEach((t, i) => {
      const li = document.createElement("li");
      li.className = t.done ? "done" : "";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = t.done; cb.setAttribute("aria-label", `Done: ${t.text || "task"}`);
      cb.addEventListener("change", () => { t.done = cb.checked; li.className = t.done ? "done" : ""; meter(); markDirty(); });
      const tx = document.createElement("input");
      tx.type = "text"; tx.value = t.text; tx.setAttribute("aria-label", "Task");
      tx.addEventListener("input", () => { t.text = tx.value; markDirty(); });
      tx.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); S.tasks.splice(i + 1, 0, { text: "", done: false }); renderTasks(i + 1); markDirty(); }
        else if (e.key === "Backspace" && !tx.value) { e.preventDefault(); S.tasks.splice(i, 1); renderTasks(Math.max(0, i - 1)); markDirty(); }
      });
      const x = document.createElement("button");
      x.type = "button"; x.className = "icon-btn x"; x.setAttribute("aria-label", "Remove task"); x.innerHTML = icon("x");
      x.addEventListener("click", () => { S.tasks.splice(i, 1); renderTasks(); markDirty(); });
      li.append(cb, tx, x);
      ul.append(li);
    });
    meter();
    if (focusIndex != null) { const inputs = $$('#task-list input[type="text"]'); (inputs[focusIndex] || $("#task-input")).focus(); }
  }
  function meter() {
    const done = S.tasks.filter(t => t.done).length, all = S.tasks.length;
    $("#task-progress").textContent = all ? `${done} of ${all} done` : "No tasks yet";
    $("#task-fill").style.width = all ? (done / all * 100) + "%" : "0";
    $("#task-clear").hidden = !done;
  }

  // ---------- persistence ----------
  const toRow = (n) => ({
    id: n.id, user_id: S.user.id, title: n.title || "", type: n.type, body: n.body || "",
    tasks: n.type === "tasks" ? (n.tasks || []) : null, pinned: !!n.pinned,
    created_at: new Date(n.createdAt).toISOString(), updated_at: new Date(n.updatedAt).toISOString(),
  });
  const fromRow = (r) => ({
    id: r.id, title: r.title, type: r.type, body: r.body, tasks: r.tasks, pinned: !!r.pinned,
    isPublic: !!r.is_public, shareExpiresAt: r.share_expires_at ? Date.parse(r.share_expires_at) : null,
    hasPassword: !!r.share_password_hash, createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at),
  });
  const localCopy = (n) => ({ id: n.id, title: n.title, type: n.type, body: n.body, tasks: n.tasks, pinned: !!n.pinned, createdAt: n.createdAt, updatedAt: n.updatedAt });

  function writeLocal(arr) {
    const ok = ls.set(KEY.notes, JSON.stringify(arr.map(localCopy)));
    if (!ok && !S.storageBlocked) {
      // A tiny test write tells "storage is full" (big images) apart from "storage is blocked".
      if (ls.set("quillnote.probe", "1")) ls.del("quillnote.probe");
      else { S.storageBlocked = true; renderBanners(); }
    }
    return ok;
  }
  function upsert(arr, n) { const i = arr.findIndex(x => x.id === n.id); if (i >= 0) arr[i] = n; else arr.push(n); }

  // Account notes that couldn't reach the server are kept on this device and sent later.
  const pendingKey = () => "quillnote.pending." + S.user.id;
  function stashPending(n) { const p = readJSON(pendingKey(), {}); p[n.id] = localCopy(n); ls.set(pendingKey(), JSON.stringify(p)); }
  async function flushPending() {
    if (S.mode !== "cloud") return;
    const p = readJSON(pendingKey(), {});
    const list = Object.values(p);
    if (!list.length) return;
    const { error } = await sb.from("notes").upsert(list.map(toRow));
    if (!error) { ls.del(pendingKey()); toast(`Synced ${list.length} ${list.length === 1 ? "change" : "changes"} made while offline`); }
  }

  async function putNote(n) {
    if (JSON.stringify(n).length > 2900000) throw { code: "too_big" };
    if (S.mode === "cloud") {
      const { error } = await sb.from("notes").upsert(toRow(n));
      if (error) throw error;
    } else if (!writeLocal([...S.notes.filter(x => x.id !== n.id), n])) {
      throw { code: S.storageBlocked ? "local_blocked" : "local_full" };
    }
    upsert(S.notes, n);
  }

  function errCopy(e) {
    const c = e && e.code;
    if (c === "too_big" || c === "23514") return "This note is too big to save. Remove an image or split it into two notes.";
    if (c === "local_full") return sb ? "This browser's storage is full. Remove some images or notes, or create a free account to keep more." : "This browser's storage is full. Remove some images or notes.";
    if (c === "local_blocked") return "This browser is blocking storage, so notes can't be kept here.";
    if (e && (e.status === 401 || c === "PGRST301")) return "Your session ended. Sign in again to keep saving.";
    if (!S.online) return "You're offline. Changes are kept on this device and sync when you're back online.";
    return "Couldn't save just now. Your changes are kept on this device; try again in a moment.";
  }

  let saving = null;
  async function save(manual) {
    clearTimeout(autoT);
    if (S.viewingShared) return;
    if (saving) { await saving; if (!manual && !S.dirty) return; }
    const data = collect();
    if (isEmpty(data)) { if (manual) toast("Add a title or some text first."); return; }
    if (!manual && !S.dirty) return;
    const now = Date.now();
    const prev = current();
    const n = {
      ...data, id: S.currentId || newId(), createdAt: prev ? prev.createdAt : now, updatedAt: now,
      pinned: prev ? !!prev.pinned : false, isPublic: prev ? prev.isPublic : false,
      shareExpiresAt: prev ? prev.shareExpiresAt : null, hasPassword: prev ? prev.hasPassword : false,
    };
    S.currentId = n.id; S.loadedAt = now; S.dirty = false; S.isExample = false;
    setSaveState("", "Saving…");
    saving = putNote(n).then(() => {
      setSaveState("ok", "Saved");
      if (S.mode === "guest" && !S.guestNoticeDismissed && !S.showGuestNotice) { S.showGuestNotice = true; renderBanners(); }
      renderList(); renderMeta();
    }).catch((e) => {
      S.dirty = true;
      if (S.mode === "cloud") { stashPending(n); upsert(S.notes, n); renderList(); }
      setSaveState("warn", S.online ? "Not saved yet" : "Offline · kept on this device");
      if (manual) toast(errCopy(e), { kind: "warn" });
    }).finally(() => { saving = null; });
    return saving;
  }

  // ---------- note actions ----------
  const TEMPLATES = [
    { id: "meeting", label: "Meeting notes", sub: "Agenda, decisions, actions", icon: "template", make: () => ({
      type: "markdown", title: `Meeting · ${new Date().toLocaleDateString([], { month: "short", day: "numeric" })}`,
      body: "**Who:** \n**Goal:** \n\n## Agenda\n- \n\n## Notes\n\n\n## Decisions\n- \n\n## Actions\n- [ ] Owner · task · due date\n" }) },
    { id: "journal", label: "Daily journal", sub: "Plan the day, reflect at night", icon: "template", make: () => ({
      type: "markdown", title: new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
      body: "## Three things for today\n1. \n2. \n3. \n\n## Notes\n\n\n## What went well\n- \n" }) },
    { id: "brief", label: "Project brief", sub: "Goal, scope, milestones", icon: "template", make: () => ({
      type: "markdown", title: "Project brief",
      body: "## Goal\nOne sentence on what success looks like.\n\n## Why now\n\n\n## In scope\n- \n\n## Out of scope\n- \n\n## Milestones\n| Date | Milestone |\n| --- | --- |\n|  |  |\n\n## Risks\n- \n" }) },
    { id: "trip", label: "Trip checklist", sub: "Things to pack and book", icon: "checklist", make: () => ({
      type: "tasks", title: "Trip checklist",
      tasks: ["Passport or ID", "Tickets and bookings", "Phone charger", "Medication", "Toiletries", "Clothes for each day", "House keys"].map(text => ({ text, done: false })) }) },
  ];

  async function startNew(type, seed = {}) {
    if (S.dirty) await save(false);
    closeShared(true);
    S.currentId = null; S.loadedAt = 0; S.isExample = false; S.dirty = false;
    loadIntoEditor({ type, title: seed.title || "", body: seed.body || "", tasks: seed.tasks || [] });
    resetChat(); renderList(); setSaveState("", "");
    if (seed.title || seed.body || (seed.tasks && seed.tasks.length)) markDirty();
    if (mqMobile.matches) setLibrary(false);
    workspace.scrollTop = 0;
    (type === "rich" ? edRich : type === "tasks" && !seed.tasks?.length ? $("#task-input") : seed.title ? (type === "tasks" ? $("#task-input") : type === "rich" ? edRich : edPlain) : titleEl).focus();
  }
  const startTemplate = (t) => { const s = t.make(); startNew(s.type, s); };

  async function openNote(id) {
    closeShared(true);
    if (id === S.currentId && !S.isExample) { if (mqMobile.matches) setLibrary(false); return; }
    if (S.dirty) await save(false);
    const n = S.notes.find(x => x.id === id);
    if (!n) return;
    S.currentId = id; S.loadedAt = n.updatedAt; S.dirty = false; S.isExample = false;
    loadIntoEditor(n);
    setSaveState("ok", "Saved");
    resetChat(); renderList();
    if (mqMobile.matches) setLibrary(false);
    workspace.scrollTop = 0;
  }

  function welcomeNote() {
    return {
      type: "rich", title: `Welcome to ${BRAND}`,
      body: `<p>This is your first note. Change anything you like; it <strong>saves itself</strong> a moment after you stop typing.</p>`
        + `<h2>Try these</h2>`
        + `<ul class="checks"><li>Select some text and use the toolbar above: <mark class="hl-yellow">highlight</mark>, <span class="tc-blue">colour</span>, lists, tables and images.</li>`
        + `<li>Press <code>${MOD} K</code> to search your notes and run any command.</li>`
        + `<li>Press <strong>Share</strong> to send a read-only link, with an optional password or expiry.</li>`
        + `<li>Choose <strong>Aa</strong> for sans, serif or mono text in three sizes.</li></ul>`
        + `<p>Tick an item by clicking its circle. Delete this note whenever you're ready.</p>`,
    };
  }
  function openMostRecentOrExample() {
    const recent = S.notes.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      S.currentId = recent.id; S.loadedAt = recent.updatedAt; S.isExample = false;
      loadIntoEditor(recent); setSaveState("ok", "Saved");
    } else {
      S.currentId = null; S.loadedAt = 0; S.isExample = true;
      loadIntoEditor(welcomeNote()); setSaveState("", "");
    }
    S.dirty = false;
    resetChat();
  }

  async function deleteNote(id) {
    const n = S.notes.find(x => x.id === id);
    if (!n) return;
    if (S.mode === "cloud") {
      const { error } = await sb.from("notes").delete().eq("id", id);
      if (error) { toast("Couldn't delete that note. Try again in a moment.", { kind: "warn" }); return; }
    }
    S.notes = S.notes.filter(x => x.id !== id);
    if (S.mode === "guest") writeLocal(S.notes);
    if (id === S.currentId) { S.dirty = false; openMostRecentOrExample(); }
    renderList();
    toast(`Deleted “${n.title || "Untitled"}”`, {
      action: "Undo", timeout: 7000,
      onAction: async () => {
        const restored = { ...n, isPublic: false, shareExpiresAt: null, hasPassword: false };
        try { await putNote(restored); renderList(); await openNote(restored.id); toast("Note restored"); }
        catch { toast("Couldn't restore that note.", { kind: "warn" }); }
      },
    });
  }

  async function duplicateNote(id) {
    if (id === S.currentId && S.dirty) await save(false);
    const src = S.notes.find(x => x.id === id);
    if (!src) return;
    const now = Date.now();
    const copy = { ...localCopy(src), id: newId(), title: (src.title || "Untitled") + " (copy)", pinned: false, createdAt: now, updatedAt: now, isPublic: false, shareExpiresAt: null, hasPassword: false };
    try { await putNote(copy); renderList(); await openNote(copy.id); toast("Duplicated"); }
    catch (e) { toast(errCopy(e), { kind: "warn" }); }
  }

  async function togglePin(id) {
    if (id === S.currentId && S.dirty) await save(false);
    const n = S.notes.find(x => x.id === id);
    if (!n) return;
    const next = { ...n, pinned: !n.pinned };
    try { await putNote(next); renderList(); toast(next.pinned ? "Pinned to the top" : "Unpinned"); }
    catch (e) { toast(errCopy(e), { kind: "warn" }); }
  }

  // ---------- library ----------
  function renderList() {
    const ul = $("#note-list");
    ul.textContent = "";
    $("#note-count").textContent = S.notes.length;
    $$("#filters button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.filter === S.filter)));
    $("#sort").value = S.sort;
    renderLibFoot();
    if (S.mode === "cloud" && !S.cloudReady) { ul.innerHTML = `<li class="empty">Loading your notes…</li>`; return; }

    const q = S.query.trim().toLowerCase();
    let rows = S.notes.map(n => ({ n, text: plainText(n) }));
    if (S.filter === "pinned") rows = rows.filter(r => r.n.pinned);
    if (S.filter === "shared") rows = rows.filter(r => isSharedNow(r.n));
    if (q) rows = rows.filter(r => (r.n.title || "").toLowerCase().includes(q) || r.text.toLowerCase().includes(q));
    const by = {
      title: (a, b) => (a.n.title || "Untitled").localeCompare(b.n.title || "Untitled", undefined, { sensitivity: "base", numeric: true }),
      created: (a, b) => b.n.createdAt - a.n.createdAt,
      updated: (a, b) => b.n.updatedAt - a.n.updatedAt,
    }[S.sort];
    rows.sort(by);

    if (!S.notes.length) { ul.innerHTML = `<li class="empty">No notes yet. Start typing and your first note appears here.</li>`; return; }
    if (!rows.length) {
      const why = q ? `Nothing matches “${esc(S.query.trim())}”.` : S.filter === "pinned" ? "No pinned notes. Pin a note from its ⋯ menu to keep it at the top." : "No shared notes. Press Share on a note to create a link.";
      ul.innerHTML = `<li class="empty">${why}</li>`;
      return;
    }
    const pinned = S.filter === "all" ? rows.filter(r => r.n.pinned) : [];
    const rest = S.filter === "all" ? rows.filter(r => !r.n.pinned) : rows;
    const label = (t) => { const li = document.createElement("li"); li.className = "list-label"; li.textContent = t; ul.append(li); };
    if (pinned.length) { label("Pinned"); pinned.forEach(r => ul.append(listItem(r))); if (rest.length) label("Notes"); }
    rest.forEach(r => ul.append(listItem(r)));
  }

  function listItem({ n, text }) {
    const li = document.createElement("li");
    li.className = "n-item" + (n.id === S.currentId && !S.viewingShared ? " current" : "");
    li.innerHTML = `<button class="n-open" type="button"><span class="n-title"><span></span></span><span class="n-snip"></span><span class="n-meta"><span class="d"></span><span class="t"></span></span></button>
      <button class="icon-btn n-more" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Actions for this note">${icon("more")}</button>`;
    const title = $(".n-title", li);
    $("span", title).textContent = n.title || "Untitled";
    if (n.pinned) title.insertAdjacentHTML("afterbegin", icon("pin"));
    if (isSharedNow(n)) title.insertAdjacentHTML("beforeend", icon(n.hasPassword ? "lock" : "globe"));
    $(".n-snip", li).textContent = text.replace(/\s+/g, " ").trim().slice(0, 140) || "No additional text";
    $(".n-meta .d", li).textContent = listDate(n.updatedAt);
    $(".n-meta .t", li).textContent = TYPES[n.type] || "";
    $(".n-open", li).addEventListener("click", () => openNote(n.id));
    const more = $(".n-more", li);
    more.addEventListener("click", (e) => { e.stopPropagation(); openItemMenu(more, n.id); });
    return li;
  }

  function renderLibFoot() {
    const foot = $("#lib-foot");
    if (S.mode === "cloud") {
      foot.innerHTML = `${icon(S.online ? "cloud" : "offline")}<span></span>`;
      $("span", foot).textContent = S.online ? "Synced to your account" : "Offline · changes sync later";
    } else {
      foot.innerHTML = `${icon("device")}<span>Saved on this device</span>`;
      if (sb) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "link-btn push"; b.textContent = "Sync";
        b.addEventListener("click", () => openAuth("signup"));
        foot.append(b);
      }
    }
  }

  // ---------- menus ----------
  function closePops(except) {
    $$(".popover").forEach(p => { if (p !== except) p.hidden = true; });
    $$("[aria-haspopup]").forEach(b => { if (!except || b.getAttribute("aria-controls") !== except.id) b.setAttribute("aria-expanded", "false"); });
    const im = $("#item-menu"); if (im && im !== except) im.remove();
  }
  function togglePop(btn, pop) {
    const open = pop.hidden;
    closePops();
    if (!open) return;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const first = pop.querySelector("button"); if (first && pop.classList.contains("menu")) first.focus();
  }
  function menuButton({ icon: ic, label, sub, kbd, danger, run }) {
    const b = document.createElement("button");
    b.type = "button"; b.setAttribute("role", "menuitem");
    if (danger) b.className = "danger";
    b.innerHTML = `${ic ? icon(ic) : ""}<span class="m-main"><span></span>${sub ? '<span class="m-sub"></span>' : ""}</span>${kbd ? "<kbd></kbd>" : ""}`;
    $(".m-main span", b).textContent = label;
    if (sub) $(".m-sub", b).textContent = sub;
    if (kbd) $("kbd", b).textContent = kbd;
    b.addEventListener("click", () => { closePops(); run(); });
    return b;
  }
  const menuSep = () => { const d = document.createElement("div"); d.className = "menu-sep"; return d; };
  const menuLabel = (t) => { const d = document.createElement("div"); d.className = "menu-label"; d.textContent = t; return d; };
  // Arrow-key navigation inside any open menu.
  document.addEventListener("keydown", (e) => {
    const menu = e.target.closest && e.target.closest(".menu");
    if (!menu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = $$("button", menu); const i = items.indexOf(e.target);
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  });

  function buildNewMenu() {
    const m = $("#menu-new");
    m.textContent = "";
    m.append(menuLabel("Blank"));
    [["rich", "rich", "Formatting, tables and images"], ["plain", "text", "A clean page, no formatting"], ["markdown", "md", "With live preview"], ["tasks", "checklist", "Tick things off"]]
      .forEach(([type, ic, sub]) => m.append(menuButton({ icon: ic, label: TYPES[type], sub, kbd: type === "rich" ? `${ALT} N` : "", run: () => startNew(type) })));
    m.append(menuSep(), menuLabel("Templates"));
    TEMPLATES.forEach(t => m.append(menuButton({ icon: t.icon, label: t.label, sub: t.sub, run: () => startTemplate(t) })));
  }

  function noteActions(id, forCurrent) {
    const n = S.notes.find(x => x.id === id);
    const items = [];
    if (n) {
      items.push({ icon: "pin", label: n.pinned ? "Unpin" : "Pin to top", run: () => togglePin(id) });
      items.push({ icon: "copy", label: "Duplicate", run: () => duplicateNote(id) });
      if (!forCurrent) items.push({ icon: "share", label: "Share…", run: async () => { await openNote(id); openShare(); } });
    }
    return items;
  }
  function buildMoreMenu() {
    const m = $("#menu-more");
    m.textContent = "";
    const n = current();
    noteActions(S.currentId, true).forEach(it => m.append(menuButton(it)));
    if (n) m.append(menuSep());
    m.append(menuLabel("Download"));
    downloadOptions().forEach(([label, file, data, mime]) => m.append(menuButton({ icon: "download", label, sub: file, run: () => doDownload(file, data, mime) })));
    m.append(menuButton({ icon: "print", label: "Print or save as PDF", run: printNote }));
    m.append(menuSep());
    m.append(menuButton({ icon: "upload", label: "Open a file…", sub: ".txt, .md, .html, .docx", run: () => $("#file-import").click() }));
    m.append(menuButton({ icon: "focus", label: "Focus mode", kbd: `${MOD} ⇧ F`, run: () => setFocus(true) }));
    if (aiAvailable()) m.append(menuButton({ icon: "spark", label: "Assistant", run: () => openAssistant() }));
    m.append(menuButton({ icon: "keyboard", label: "Keyboard shortcuts", kbd: `${MOD} /`, run: openKeys }));
    if (n) { m.append(menuSep()); m.append(menuButton({ icon: "trash", label: "Delete note", danger: true, run: () => deleteNote(n.id) })); }
  }

  function openItemMenu(btn, id) {
    const wasOpen = btn.getAttribute("aria-expanded") === "true";
    closePops();
    if (wasOpen) return;
    const m = document.createElement("div");
    m.className = "popover menu"; m.id = "item-menu"; m.setAttribute("role", "menu");
    noteActions(id, false).forEach(it => m.append(menuButton(it)));
    m.append(menuSep(), menuButton({ icon: "trash", label: "Delete", danger: true, run: () => deleteNote(id) }));
    document.body.append(m);
    const r = btn.getBoundingClientRect();
    m.style.position = "fixed";
    m.style.top = Math.min(r.bottom + 4, window.innerHeight - m.offsetHeight - 8) + "px";
    m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, window.innerWidth - m.offsetWidth - 8)) + "px";
    btn.setAttribute("aria-expanded", "true");
    m.querySelector("button").focus();
  }

  // ---------- sharing ----------
  const shareUrl = (id) => `${location.origin}${location.pathname}?s=${id}`;
  const EXPIRY = [["never", "Never", 0], ["1h", "In 1 hour", 3600e3], ["1d", "In 1 day", 864e5], ["7d", "In 7 days", 7 * 864e5], ["30d", "In 30 days", 30 * 864e5]];
  const shareDlg = $("#share-dlg");

  async function openShare() {
    closePops();
    const body = $("#share-body");
    const head = `<div class="dlg-head"><h2 id="share-h">Share</h2><button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button></div>`;
    if (S.mode !== "cloud") {
      body.innerHTML = `${head}<p class="dlg-sub">Links need a free account. Guest notes live only in this browser, so there's nothing for a link to open yet. Create an account in seconds and your notes move into it.</p>
        <div class="dlg-actions"><button class="btn btn-primary" type="button" id="share-signup">${sb ? "Create free account" : "Accounts aren't set up yet"}</button><button class="btn" type="button" data-close>Not now</button></div>`;
      $("#share-signup").disabled = !sb;
      $("#share-signup").addEventListener("click", () => { shareDlg.close(); openAuth("signup"); });
      showDialog(shareDlg);
      return;
    }
    if (isEmpty(collect())) {
      body.innerHTML = `${head}<p class="dlg-sub">Write something first. A note needs a title or some text before it can be shared.</p><div class="dlg-actions"><button class="btn" type="button" data-close>OK</button></div>`;
      showDialog(shareDlg);
      return;
    }
    if (!S.currentId || S.dirty) await save(true);
    if (!current()) return;
    renderShare();
    showDialog(shareDlg);
  }

  function renderShare(msg, kind) {
    const n = current();
    if (!n) return;
    const on = isSharedNow(n);
    const body = $("#share-body");
    const expiryOptions = EXPIRY.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    const currentExpiry = n.shareExpiresAt ? `<option value="keep" selected>${esc("On " + longDate(n.shareExpiresAt))}</option>` : "";
    body.innerHTML = `
      <div class="dlg-head"><h2 id="share-h">Share</h2><button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button></div>
      <p class="dlg-sub"></p>
      <div class="group">
        <label class="switch"><input type="checkbox" role="switch" id="share-toggle" ${on ? "checked" : ""}> Link sharing</label>
        ${on ? `
          <div class="link-row"><input class="input" id="share-url" type="text" readonly aria-label="Share link"><button class="btn btn-primary" type="button" id="share-copy">Copy</button></div>
          <div class="row"><span>Link stops working</span><select class="select select-auto" id="share-expiry">${currentExpiry}${expiryOptions.replace('value="never"', n.shareExpiresAt ? 'value="never"' : 'value="never" selected')}</select></div>
          ${n.hasPassword
            ? `<div class="row"><span>${icon("lock")} Password required</span><button class="btn btn-sm" type="button" id="share-pw-remove">Remove password</button></div>`
            : `<div class="pw-row"><input class="input" id="share-pw" type="password" placeholder="Add a password (optional)" autocomplete="new-password" minlength="4" maxlength="128" aria-label="Share password"><button class="btn btn-sm" type="button" id="share-pw-set">Add</button></div>`}
        ` : ""}
      </div>
      <p class="hint" id="share-hint"></p>
      <p class="dlg-msg" id="share-msg" role="status"></p>`;
    $(".dlg-sub", body).textContent = `“${n.title || "Untitled"}”`;
    $("#share-hint").textContent = on
      ? `Anyone with the link can read this note${n.hasPassword ? " after typing the password" : ""}. They can't edit it. Changes you save appear for them straight away.`
      : "Only you can see this note.";
    if (msg) { $("#share-msg").textContent = msg; $("#share-msg").dataset.kind = kind || ""; }
    $("#share-toggle").addEventListener("change", (e) => setSharing({ pub: e.target.checked }));
    if (!on) return;
    $("#share-url").value = shareUrl(n.id);
    $("#share-copy").addEventListener("click", () => copyText($("#share-url"), $("#share-copy")));
    $("#share-expiry").addEventListener("change", (e) => {
      const v = e.target.value;
      if (v === "keep") return;
      const ms = EXPIRY.find(x => x[0] === v)[2];
      setSharing({ pub: true, expires: ms ? new Date(Date.now() + ms).toISOString() : null });
    });
    const setBtn = $("#share-pw-set");
    if (setBtn) {
      const go = () => {
        const pw = $("#share-pw").value;
        if (pw.length < 4) { renderShare("Use at least 4 characters for the password.", "warn"); return; }
        setSharing({ pub: true, password: pw });
      };
      setBtn.addEventListener("click", go);
      $("#share-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    }
    const rm = $("#share-pw-remove");
    if (rm) rm.addEventListener("click", () => setSharing({ pub: true, clear: true }));
  }

  async function setSharing({ pub, expires, password, clear }) {
    const n = current();
    if (!n) return;
    const keepExpiry = expires === undefined ? (n.shareExpiresAt && n.shareExpiresAt > Date.now() ? new Date(n.shareExpiresAt).toISOString() : null) : expires;
    const { data, error } = await sb.rpc("set_note_sharing", {
      p_note_id: n.id, p_public: !!pub, p_expires_at: pub ? keepExpiry : null,
      p_password: password || null, p_clear_password: !!clear,
    });
    if (error || data === false) { renderShare("Couldn't change sharing. Check your connection and try again.", "warn"); return; }
    upsert(S.notes, {
      ...n, isPublic: !!pub, shareExpiresAt: pub && keepExpiry ? Date.parse(keepExpiry) : null,
      hasPassword: pub ? (clear ? false : password ? true : n.hasPassword) : false,
    });
    const msg = !pub ? "Link turned off. The old link no longer works." : password ? "Password added." : clear ? "Password removed." : expires !== undefined ? (expires ? `Link stops working ${longDate(Date.parse(expires))}.` : "Link no longer expires.") : "Link is on. Copy it and send it to anyone.";
    renderShare(msg, "ok"); renderList(); renderMeta();
  }

  function copyText(input, btn) {
    const done = () => { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy"; }, 1600); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(input.value).then(done, () => { input.select(); });
    else { input.select(); try { document.execCommand("copy"); done(); } catch { /* user can copy manually */ } }
  }

  // ---------- shared view (?s=<id>) ----------
  function renderReadOnly(n, host) {
    host.textContent = "";
    host.className = "shared-body";
    if (n.type === "rich") { host.classList.add("prose"); host.innerHTML = sanitize(n.body); }
    else if (n.type === "markdown") { host.classList.add("prose"); host.innerHTML = mdToHtml(n.body); }
    else if (n.type === "tasks") {
      const ul = document.createElement("ul"); ul.className = "ro-tasks";
      (n.tasks || []).forEach(t => { const li = document.createElement("li"); li.textContent = t.text; if (t.done) li.className = "done"; ul.append(li); });
      host.append(ul);
    } else { const d = document.createElement("div"); d.className = "plain-ro"; d.textContent = n.body || ""; host.append(d); }
    host.querySelectorAll("a[href]").forEach(a => { a.target = "_blank"; a.rel = "noopener noreferrer nofollow ugc"; });
  }

  function showSharedChrome(on) {
    S.viewingShared = on;
    $("#shared-view").hidden = !on;
    paper.hidden = on;
    $("#doc-bar").hidden = on;
  }

  async function handleShareParam() {
    const id = new URLSearchParams(location.search).get("s");
    if (!id) return;
    showSharedChrome(true);
    S.sharedId = id;
    if (!UUID_RE.test(id) || !sb) {
      setSharedState("This link isn't complete", "Ask the person who shared it to copy the link again.");
      return;
    }
    await loadShared(null);
  }
  function setSharedState(title, text, eyebrow = "globe", eyebrowText = "Shared note · read only") {
    $("#shared-eyebrow").innerHTML = `${icon(eyebrow)}<span></span>`;
    $("#shared-eyebrow span").textContent = eyebrowText;
    $("#shared-title").textContent = title;
    $("#shared-meta").textContent = "";
    const body = $("#shared-body"); body.className = "shared-body"; body.textContent = text || "";
    $("#shared-copy").hidden = true;
    $("#unlock-form").hidden = true;
    $("#shared-report").hidden = true;
  }
  async function loadShared(password) {
    if (!password) setSharedState("Opening shared note…", "");
    const { data, error } = await sb.rpc("open_shared_note", { p_note_id: S.sharedId, p_password: password });
    const msg = $("#unlock-msg");
    msg.textContent = "";
    if (error) { setSharedState("Couldn't open this note", "Check your connection and reload the page."); return; }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) { setSharedState("This link isn't available", "The owner turned sharing off, the link has expired, or the note was deleted."); return; }
    if (row.locked) {
      setSharedState("This note is password protected", "Enter the password the owner gave you.", "lock", "Protected note");
      $("#unlock-form").hidden = false;
      if (password) { msg.textContent = "That password isn't right. Check it and try again."; msg.dataset.kind = "warn"; }
      $("#unlock-pw").value = ""; $("#unlock-pw").focus();
      return;
    }
    const n = { title: row.title, type: row.type, body: row.body, tasks: row.tasks, updatedAt: Date.parse(row.updated_at) };
    S.shared = n;
    $("#shared-eyebrow").innerHTML = `${icon("globe")}<span>Shared note · read only</span>`;
    $("#shared-title").textContent = n.title || "Untitled";
    $("#shared-meta").textContent = `${TYPES[n.type] || "Note"} · updated ${fmtAgo(n.updatedAt)}`;
    $("#unlock-form").hidden = true;
    renderReadOnly(n, $("#shared-body"));
    $("#shared-copy").hidden = false;
    if (CFG.contactEmail) {
      const r = $("#shared-report");
      r.href = `mailto:${encodeURIComponent(CFG.contactEmail).replace("%40", "@")}?subject=${encodeURIComponent("Report a shared note " + S.sharedId)}`;
      r.hidden = false;
    }
  }
  function closeShared(silent) {
    if (!S.viewingShared) return;
    showSharedChrome(false);
    S.shared = null; S.sharedId = null;
    history.replaceState(null, "", location.pathname);
    if (!silent) titleEl.focus();
    renderList();
  }

  // ---------- banners ----------
  function renderBanners() {
    const host = $("#banners");
    host.textContent = "";
    if (S.notice) host.append(banner(S.notice.kind || "", S.notice.title, S.notice.text, [["OK", () => { S.notice = null; renderBanners(); }]]));
    if (S.storageBlocked) {
      host.append(banner("warn", "This browser is blocking storage",
        sb ? "Guest notes can't be kept after you close this tab. Create a free account to keep them." : "Notes can't be kept after you close this tab. Download anything you want to keep.", []));
    }
    if (S.mode === "guest" && S.showGuestNotice && !S.storageBlocked) {
      const actions = [];
      if (sb) actions.push(["Create free account", () => openAuth("signup"), true]);
      actions.push(["Not now", () => { S.showGuestNotice = false; S.guestNoticeDismissed = true; ss.set(KEY.guestNotice, "off"); renderBanners(); }]);
      host.append(banner("", "Saved on this device",
        sb ? "Your notes wait in this browser until its cookies or site data are cleared. A free account keeps them safe and opens them on any device. Notes you've already written move into it."
           : "Your notes wait in this browser until its cookies or site data are cleared.", actions));
    }
  }
  function banner(kind, title, text, actions) {
    const d = document.createElement("div");
    d.className = "banner" + (kind ? " " + kind : "");
    d.innerHTML = `<div class="b-text"><strong></strong><span></span></div><div class="b-actions"></div>`;
    $("strong", d).textContent = title;
    $(".b-text span", d).textContent = text;
    for (const [label, fn, primary] of actions) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn btn-sm" + (primary ? " btn-primary" : ""); b.textContent = label;
      b.addEventListener("click", fn);
      $(".b-actions", d).append(b);
    }
    return d;
  }

  // ---------- accounts ----------
  const authDlg = $("#auth-dlg");
  const NO_RESET_NOTE = CFG.contactEmail
    ? ` Passwords can't be reset by email, so keep yours somewhere safe. Locked out? Write to ${CFG.contactEmail}.`
    : " Passwords can't be reset by email, so keep yours somewhere safe.";
  const AUTH_MODES = {
    signup: { h: "Create your free account", sub: "Use your email and a password of at least 8 characters. You can use it straight away, and notes you've written here move into it." + (CFG.passwordResetEmails ? "" : NO_RESET_NOTE), submit: "Create account", email: true, pw: true, confirm: true, tabs: true },
    signin: { h: "Welcome back", sub: "Sign in to open your notes. Notes written on this device as a guest move into your account." + (CFG.passwordResetEmails ? "" : NO_RESET_NOTE), submit: "Sign in", email: true, pw: true, forgot: CFG.passwordResetEmails, tabs: true },
    forgot: { h: "Reset your password", sub: "Enter your account email and we'll send you a link to choose a new password.", submit: "Email me a reset link", email: true, back: true },
    reset: { h: "Choose a new password", sub: "Use at least 8 characters.", submit: "Save new password", pw: true, confirm: true },
  };
  let authMode = "signup";
  function authMsg(text, kind = "") { const m = $("#auth-msg"); m.textContent = text; m.dataset.kind = kind; }
  function setAuthMode(mode) {
    const m = AUTH_MODES[mode];
    authMode = mode;
    $("#auth-h").textContent = m.h;
    $("#auth-sub").textContent = m.sub;
    $("#auth-submit").textContent = m.submit;
    $("#auth-tabs").hidden = !m.tabs;
    $$("#auth-tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
    $("#email-wrap").hidden = !m.email;
    $("#password-wrap").hidden = !m.pw;
    $("#show-wrap").hidden = !m.pw;
    $("#confirm-wrap").hidden = !m.confirm;
    $("#auth-forgot").hidden = !m.forgot;
    $("#auth-back").hidden = !m.back;
    $("#google-wrap").hidden = !CFG.googleSignIn || !m.tabs;
    $("#auth-password").autocomplete = mode === "signin" ? "current-password" : "new-password";
    $("#auth-password").value = ""; $("#auth-confirm").value = "";
    authMsg("");
  }
  function openAuth(mode) {
    if (!sb) return;
    closePops();
    setAuthMode(typeof mode === "string" ? mode : "signup");
    showDialog(authDlg);
    (authMode === "reset" ? $("#auth-password") : $("#auth-email")).focus();
  }
  const redirectTo = () => location.origin + location.pathname;

  function authErrorCopy(err) {
    const code = (err && err.code) || "", msg = (err && err.message) || "";
    if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return "That email and password don't match. Check both and try again.";
    if (code === "email_not_confirmed" || /not confirmed/i.test(msg)) return "This account hasn't been confirmed yet.";
    if (code === "user_already_exists" || /already registered/i.test(msg)) return "An account with this email already exists. Sign in instead.";
    if (code === "weak_password" || (/password/i.test(msg) && /weak|short|least/i.test(msg))) return "That password is too easy to guess. Use a longer one with a mix of letters, numbers and symbols.";
    if (code === "same_password") return "That's your current password. Choose a different one.";
    if ((err && err.status === 429) || /rate limit/i.test(msg)) return "Too many attempts. Wait a few minutes and try again.";
    if (code === "signup_disabled") return "New accounts are switched off right now.";
    return "Something went wrong. Check your connection and try again.";
  }

  async function submitAuth() {
    const email = $("#auth-email").value.trim(), pw = $("#auth-password").value, confirm = $("#auth-confirm").value;
    const m = AUTH_MODES[authMode];
    if (m.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authMsg("Enter a valid email address.", "warn");
    if (m.pw && !pw) return authMsg("Enter your password.", "warn");
    if (m.confirm && pw.length < 8) return authMsg("Use at least 8 characters for your password.", "warn");
    if (m.confirm && pw !== confirm) return authMsg("The two passwords don't match.", "warn");
    const btn = $("#auth-submit");
    btn.disabled = true;
    authMsg("One moment…");
    try {
      if (authMode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password: pw });
        if (error) return authMsg(authErrorCopy(error), "warn");
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          setAuthMode("signin"); $("#auth-email").value = email;
          return authMsg("An account with this email already exists. Sign in instead.", "warn");
        }
        if (!data.session) {
          setAuthMode("signin"); $("#auth-email").value = email;
          return authMsg(`Account created. Open the confirmation link sent to ${email}, then sign in here.`, "ok");
        }
        authMsg("Account created.", "ok");
      } else if (authMode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password: pw });
        if (error) return authMsg(authErrorCopy(error), "warn");
        authMsg("Signed in.", "ok");
      } else if (authMode === "forgot") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
        if (error) return authMsg(authErrorCopy(error), "warn");
        authMsg(`If an account exists for ${email}, a reset link is on its way.`, "ok");
      } else if (authMode === "reset") {
        const { error } = await sb.auth.updateUser({ password: pw });
        if (error) return authMsg(authErrorCopy(error), "warn");
        authDlg.close();
        toast("Password updated");
      }
    } catch {
      authMsg("Something went wrong. Check your connection and try again.", "warn");
    } finally {
      btn.disabled = false;
    }
  }

  function updateAccountUI() {
    const cloud = S.mode === "cloud";
    const pill = $("#sync-pill");
    pill.dataset.mode = cloud && S.online ? "cloud" : "guest";
    $("#sync-text").textContent = !S.online ? "Offline" : cloud ? "Synced" : "On this device";
    pill.title = !S.online ? "You're offline. Changes are kept on this device." : cloud ? "Your notes are saved to your account." : "Notes are saved in this browser only.";
    $("#btn-signin").hidden = !sb || cloud;
    $("#acct").hidden = !cloud;
    $("#acct-email").textContent = cloud ? (S.user.email || "your account") : "";
    $("#avatar-initial").textContent = cloud && S.user.email ? S.user.email[0].toUpperCase() : "Q";
    renderLibFoot();
  }

  async function enterCloud(user) {
    if (S.dirty) await save(false);
    const guestNotes = loadLocalNotes();
    const openGuest = S.notes.find(x => x.id === S.currentId);
    S.mode = "cloud"; S.user = user; S.cloudReady = false; S.showGuestNotice = false;
    if (authDlg.open) authDlg.close();
    updateAccountUI(); renderBanners(); renderList();
    if (guestNotes.length) {
      const { error } = await sb.from("notes").upsert(guestNotes.map(n => toRow({ ...n, isPublic: false })));
      if (error) {
        S.notice = { kind: "warn", title: "Your guest notes are still on this device", text: "They couldn't be moved into your account just now. Reload the page to try again." };
      } else {
        ls.del(KEY.notes);
        toast(`Moved ${guestNotes.length} ${guestNotes.length === 1 ? "note" : "notes"} into your account`);
      }
      renderBanners();
    }
    await flushPending();
    await refreshCloud(openGuest ? openGuest.id : S.currentId);
  }

  async function refreshCloud(keepId) {
    if (S.mode !== "cloud") return;
    const { data, error } = await sb.from("notes").select(NOTE_COLUMNS).order("updated_at", { ascending: false }).limit(2000);
    if (error) { setSaveState("warn", "Couldn't load notes"); return; }
    S.cloudReady = true;
    const pending = readJSON(pendingKey(), {});
    S.notes = data.map(fromRow);
    Object.values(pending).forEach(p => { const have = S.notes.find(x => x.id === p.id); if (!have || have.updatedAt < p.updatedAt) upsert(S.notes, { ...(have || {}), ...p }); });
    const target = S.notes.find(x => x.id === (keepId || S.currentId));
    if (target && !S.dirty) {
      if (target.updatedAt > S.loadedAt || target.id !== S.currentId) { S.currentId = target.id; S.loadedAt = target.updatedAt; loadIntoEditor(target); setSaveState("ok", "Saved"); }
    } else if (!S.dirty && (S.isExample || !target)) {
      openMostRecentOrExample();
    }
    renderList(); renderMeta();
  }

  function leaveCloud() {
    S.mode = "guest"; S.user = null; S.cloudReady = false; S.notice = null; S.dirty = false;
    S.notes = loadLocalNotes();
    openMostRecentOrExample();
    updateAccountUI(); renderBanners(); renderList();
  }

  // Account deletion: removes the account and every note in it (privacy-law right to erasure).
  const delDlg = $("#delete-dlg");
  function openDeleteAccount() {
    closePops();
    $("#del-confirm").value = "";
    $("#del-msg").textContent = "";
    $("#del-email").textContent = S.user && S.user.email ? S.user.email : "your account";
    showDialog(delDlg);
    $("#del-confirm").focus();
  }
  async function deleteAccount() {
    if ($("#del-confirm").value.trim().toUpperCase() !== "DELETE") {
      $("#del-msg").textContent = "Type DELETE to confirm."; $("#del-msg").dataset.kind = "warn"; return;
    }
    const btn = $("#del-submit"); btn.disabled = true;
    const { error } = await sb.rpc("delete_my_account");
    btn.disabled = false;
    if (error) { $("#del-msg").textContent = "Couldn't delete your account. Check your connection and try again."; $("#del-msg").dataset.kind = "warn"; return; }
    if (S.user) ls.del(pendingKey());
    delDlg.close();
    await sb.auth.signOut().catch(() => {});
    leaveCloud();
    toast("Your account and its notes were deleted");
  }

  // ---------- import / export ----------
  const slug = (s) => (s || "note").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "note";
  const docShell = (title, inner) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#17191e}pre{background:#f2f3f5;padding:12px;border-radius:8px;overflow:auto}</style></head><body><h1>${esc(title)}</h1>${inner}</body></html>`;
  const wordShell = (title, inner) => `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${inner}</body></html>`;
  function noteHtml(n) {
    if (n.type === "rich") return sanitize(n.body);
    if (n.type === "markdown") return mdToHtml(n.body);
    if (n.type === "tasks") return "<ul>" + (n.tasks || []).map(t => `<li>${t.done ? "☑" : "☐"} ${esc(t.text)}</li>`).join("") + "</ul>";
    return (n.body || "").split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  }
  function downloadOptions() {
    const n = collect(), base = slug(n.title), title = n.title || "Untitled";
    const opts = [];
    if (n.type === "markdown") opts.push(["Markdown", base + ".md", n.body, "text/markdown"]);
    if (n.type === "tasks") opts.push(["Markdown checklist", base + ".md", (n.title ? "# " + n.title + "\n\n" : "") + (n.tasks || []).map(t => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n"), "text/markdown"]);
    opts.push(["Plain text", base + ".txt", n.type === "plain" ? n.body : (n.title ? n.title + "\n\n" : "") + plainText(n), "text/plain"]);
    opts.push(["Word document", base + ".doc", wordShell(title, noteHtml(n)), "application/msword"]);
    opts.push(["Web page", base + ".html", docShell(title, noteHtml(n)), "text/html"]);
    return opts;
  }
  function doDownload(filename, data, mime) {
    if (!data || !String(data).trim()) { toast("This note is empty. Add something before downloading."); return; }
    const url = URL.createObjectURL(new Blob([data], { type: (mime || "text/plain") + ";charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Downloaded ${filename}`);
  }
  function printNote() {
    const n = collect();
    if (isEmpty(n)) { toast("This note is empty. Add something before printing."); return; }
    const area = $("#print-area");
    area.textContent = "";
    const h = document.createElement("h1"); h.textContent = n.title || "Untitled";
    const body = document.createElement("div");
    renderReadOnly(n, body);
    area.append(h, body);
    window.print();
  }

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
  }
  async function importFile(f) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const title = f.name.replace(/\.[^.]+$/, "").slice(0, 200);
    if (f.size > 5 * 1024 * 1024) { toast("That file is over 5 MB. Choose a smaller one.", { kind: "warn" }); return; }
    try {
      if (ext === "txt") return startNew("plain", { title, body: await f.text() });
      if (ext === "md" || ext === "markdown") return startNew("markdown", { title, body: await f.text() });
      if (ext === "html" || ext === "htm") {
        const doc = new DOMParser().parseFromString(await f.text(), "text/html");
        return startNew("rich", { title: (doc.title || title).slice(0, 200), body: sanitize(doc.body.innerHTML) });
      }
      if (ext === "docx") {
        toast(`Opening ${f.name}…`);
        if (!window.mammoth) await loadScript("vendor/mammoth.browser.min.js");
        const out = await window.mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() });
        return startNew("rich", { title, body: sanitize(out.value) });
      }
      toast("Choose a .txt, .md, .html or .docx file.", { kind: "warn" });
    } catch { toast(`Couldn't open ${f.name}. Try saving it as .txt or .docx first.`, { kind: "warn" }); }
  }

  // ---------- assistant ----------
  const aiAvailable = () => !!(CFG.aiEnabled && sb);
  function openAssistant() {
    if (!aiAvailable()) return;
    $("#assistant").hidden = false;
    $("#app").classList.add("with-assistant");
    renderChat();
    $("#chat-input").focus();
  }
  function closeAssistant() { $("#assistant").hidden = true; $("#app").classList.remove("with-assistant"); }
  function resetChat() { if (S.chatCtl) S.chatCtl.abort(); S.chat = []; renderChat(); }
  function renderChat() {
    if ($("#assistant").hidden) return;
    const log = $("#chat-log");
    log.textContent = "";
    const t = titleEl.value.trim();
    $("#chat-about").textContent = S.mode !== "cloud"
      ? "Sign in to use the assistant. It reads the open note and answers questions about it."
      : t ? `Reading “${t}” as it is right now.` : "The assistant reads the open note and answers questions about it.";
    $("#chat-chips").hidden = S.chat.length > 0;
    S.chat.forEach((m) => {
      const d = document.createElement("div");
      d.className = "msg " + m.role;
      d.textContent = m.role === "assistant" && m.pending ? "Thinking…" : m.content;
      if (m.note) { const s = document.createElement("span"); s.className = "m-note"; s.textContent = m.note; d.append(s); }
      if (m.role === "assistant" && !m.pending && m.content && !m.error) {
        const row = document.createElement("div"); row.className = "m-actions";
        const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-sm"; b.textContent = "Add to note";
        b.addEventListener("click", () => { appendToNote(m.content); b.textContent = "Added"; b.disabled = true; });
        row.append(b); d.append(row);
      }
      log.append(d);
    });
    $("#chat-stop").hidden = !S.chatCtl;
    $("#chat-send").disabled = !!S.chatCtl;
  }
  function appendToNote(text) {
    if (S.type === "rich") {
      edRich.insertAdjacentHTML("beforeend", text.split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join(""));
    } else if (S.type === "tasks") {
      text.split("\n").map(l => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s*/, "").trim()).filter(Boolean).forEach(l => S.tasks.push({ text: l, done: false }));
      renderTasks();
    } else {
      edPlain.value = edPlain.value.replace(/\s*$/, "") + (edPlain.value.trim() ? "\n\n" : "") + text;
      renderPreviewSoon(); autosize();
    }
    markDirty();
  }
  const AI_ERRORS = {
    daily_limit: "You've reached today's assistant limit. It resets tomorrow.",
    sign_in_required: "Your session ended. Sign in again, then send your message.",
    refused: "The assistant didn't answer that one. Try asking a different way.",
    busy: "The assistant is busy right now. Try again in a minute.",
  };
  async function ask(text) {
    text = text.trim();
    if (!text || S.chatCtl) return;
    if (S.mode !== "cloud") { openAuth("signin"); return; }
    S.chat.push({ role: "user", content: text });
    const reply = { role: "assistant", content: "", pending: true };
    S.chat.push(reply);
    const ctl = S.chatCtl = new AbortController();
    renderChat();
    const n = collect();
    const turns = S.chat.filter(m => m !== reply && !m.error && m.content).map(m => ({ role: m.role, content: m.content })).slice(-20);
    try {
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch(`${CFG.supabaseUrl}/functions/v1/ask`, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", apikey: CFG.supabaseAnonKey, Authorization: `Bearer ${session ? session.access_token : ""}` },
        body: JSON.stringify({ note: { title: n.title, type: TYPES[n.type], text: plainText(n).slice(0, 12000) }, messages: turns }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.text) { reply.error = true; reply.note = AI_ERRORS[out.error] || "The assistant couldn't answer just now. Send your message again."; }
      else { reply.content = out.text; if (out.truncated) reply.note = "The answer was cut short. Ask for less at a time."; }
    } catch (e) {
      reply.error = true;
      reply.note = e && e.name === "AbortError" ? "Stopped." : "Couldn't reach the assistant. Check your connection and send again.";
    } finally {
      reply.pending = false; S.chatCtl = null; renderChat();
    }
  }

  // ---------- focus mode ----------
  function setFocus(on) {
    closePops();
    document.body.classList.toggle("focus", on);
    if (on) { toast(`Focus mode · press Esc to leave`); (S.type === "rich" ? edRich : S.type === "tasks" ? $("#task-input") : edPlain).focus(); }
  }

  // ---------- command menu ----------
  const palette = $("#palette");
  let palItems = [], palIndex = 0;
  function commandList() {
    const cmds = [
      { group: "Create", icon: "rich", label: "New note", sub: "Rich text", kbd: `${ALT} N`, run: () => startNew("rich") },
      { group: "Create", icon: "text", label: "New plain text note", run: () => startNew("plain") },
      { group: "Create", icon: "md", label: "New Markdown note", run: () => startNew("markdown") },
      { group: "Create", icon: "checklist", label: "New checklist", run: () => startNew("tasks") },
      ...TEMPLATES.map(t => ({ group: "Create", icon: t.icon, label: `Template: ${t.label}`, sub: t.sub, run: () => startTemplate(t) })),
      { group: "This note", icon: "share", label: "Share this note…", run: openShare },
      ...noteActions(S.currentId, true).map(a => ({ ...a, group: "This note" })),
      ...downloadOptions().map(([label, file, data, mime]) => ({ group: "This note", icon: "download", label: `Download as ${label}`, sub: file, run: () => doDownload(file, data, mime) })),
      { group: "This note", icon: "print", label: "Print or save as PDF", run: printNote },
      { group: "General", icon: "upload", label: "Open a file…", run: () => $("#file-import").click() },
      { group: "General", icon: "focus", label: document.body.classList.contains("focus") ? "Leave focus mode" : "Focus mode", kbd: `${MOD} ⇧ F`, run: () => setFocus(!document.body.classList.contains("focus")) },
      { group: "General", icon: "sidebar", label: libraryOpen() ? "Hide notes list" : "Show notes list", kbd: `${MOD} \\`, run: () => setLibrary(!libraryOpen()) },
      { group: "General", icon: "sun", label: "Theme: Light", run: () => setTheme("light", true) },
      { group: "General", icon: "moon", label: "Theme: Dark", run: () => setTheme("dark", true) },
      { group: "General", icon: "auto", label: "Theme: Automatic", run: () => setTheme("system", true) },
      { group: "General", icon: "keyboard", label: "Keyboard shortcuts", kbd: `${MOD} /`, run: openKeys },
      { group: "General", icon: "globe", label: "Features and pricing", run: () => { location.href = "features.html"; } },
    ];
    if (aiAvailable()) cmds.push({ group: "General", icon: "spark", label: "Open the assistant", run: openAssistant });
    if (current()) cmds.push({ group: "This note", icon: "trash", label: "Delete this note", run: () => deleteNote(S.currentId) });
    if (sb && S.mode !== "cloud") cmds.push({ group: "Account", icon: "user", label: "Create a free account", run: () => openAuth("signup") }, { group: "Account", icon: "user", label: "Sign in", run: () => openAuth("signin") });
    if (S.mode === "cloud") cmds.push({ group: "Account", icon: "lock", label: "Change password", run: () => openAuth("reset") }, { group: "Account", icon: "user", label: "Sign out", run: signOut });
    return cmds;
  }
  function openPalette() {
    closePops();
    $("#pal-q").value = "";
    renderPalette();
    showDialog(palette);
    $("#pal-q").focus();
  }
  function renderPalette() {
    const q = $("#pal-q").value.trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const match = (s) => words.every(w => s.toLowerCase().includes(w));
    const notes = S.notes.slice().sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(n => !q || match((n.title || "Untitled") + " " + plainText(n).slice(0, 2000)))
      .slice(0, q ? 8 : 5)
      .map(n => ({ group: q ? "Notes" : "Recent notes", icon: n.pinned ? "pin" : "template", label: n.title || "Untitled", sub: plainText(n).replace(/\s+/g, " ").slice(0, 80), run: () => openNote(n.id) }));
    const cmds = commandList().filter(c => !q || match(c.label + " " + (c.sub || "") + " " + c.group));
    palItems = q ? [...notes, ...cmds] : [...notes, ...cmds];
    palIndex = 0;
    const ul = $("#pal-list");
    ul.textContent = "";
    if (!palItems.length) { ul.innerHTML = `<li class="pal-empty">No notes or commands match. Try another word.</li>`; return; }
    let group = "";
    palItems.forEach((c, i) => {
      if (c.group !== group) { group = c.group; const l = document.createElement("li"); l.className = "menu-label"; l.setAttribute("role", "presentation"); l.textContent = group; ul.append(l); }
      const li = document.createElement("li");
      li.className = "pal-item"; li.id = `pal-opt-${i}`; li.setAttribute("role", "option");
      li.innerHTML = `${icon(c.icon || "template")}<span class="m-main"><span></span>${c.sub ? '<span class="m-sub"></span>' : ""}</span>${c.kbd ? "<kbd></kbd>" : ""}`;
      $(".m-main span", li).textContent = c.label;
      if (c.sub) $(".m-sub", li).textContent = c.sub;
      if (c.kbd) $("kbd", li).textContent = c.kbd;
      li.addEventListener("mousemove", () => { if (palIndex !== i) { palIndex = i; markPal(); } });
      li.addEventListener("click", () => runPal(i));
      ul.append(li);
    });
    markPal();
  }
  function markPal() {
    $$(".pal-item").forEach(li => li.setAttribute("aria-selected", String(li.id === `pal-opt-${palIndex}`)));
    const el = $(`#pal-opt-${palIndex}`);
    $("#pal-q").setAttribute("aria-activedescendant", el ? el.id : "");
    if (el) el.scrollIntoView({ block: "nearest" });
  }
  function runPal(i) { const c = palItems[i]; if (!c) return; palette.close(); c.run(); }

  // ---------- keyboard shortcuts ----------
  const SHORTCUTS = [
    ["Command menu", [MOD, "K"]], ["Save now", [MOD, "S"]], ["New note", [ALT, "N"]],
    ["Focus mode", [MOD, "⇧", "F"]], ["Show or hide notes", [MOD, "\\"]], ["Keyboard shortcuts", [MOD, "/"]],
    ["Bold · Italic · Underline (rich text)", [MOD, "B · I · U"]], ["Leave focus mode or close a window", ["Esc"]],
  ];
  const keysDlg = $("#keys-dlg");
  function openKeys() {
    closePops();
    const list = $("#keys-list");
    list.textContent = "";
    SHORTCUTS.forEach(([label, keys]) => {
      const row = document.createElement("div");
      const l = document.createElement("span"); l.textContent = label;
      const k = document.createElement("span");
      keys.forEach(key => { const kb = document.createElement("kbd"); kb.textContent = key; k.append(kb); });
      row.append(l, k); list.append(row);
    });
    showDialog(keysDlg);
  }

  // ---------- dialogs & toasts ----------
  function showDialog(d) {
    $$("dialog[open]").forEach(o => { if (o !== d) o.close(); });
    if (!d.open) d.showModal();
  }
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-close]");
    if (c) { const d = c.closest("dialog"); if (d) d.close(); }
  });
  // Clicking the dimmed backdrop closes a dialog.
  $$("dialog").forEach(d => d.addEventListener("click", (e) => { if (e.target === d) d.close(); }));

  function toast(msg, { action, onAction, kind, timeout = 3600 } = {}) {
    const host = $("#toasts");
    while (host.children.length >= 3) host.firstChild.remove();
    const t = document.createElement("div");
    t.className = "toast" + (kind === "warn" ? " warn" : "");
    t.setAttribute("role", kind === "warn" ? "alert" : "status");
    const s = document.createElement("span"); s.textContent = msg; t.append(s);
    let timer;
    if (action) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = action;
      b.addEventListener("click", () => { clearTimeout(timer); t.remove(); onAction && onAction(); });
      t.append(b);
    }
    host.append(t);
    timer = setTimeout(() => t.remove(), timeout);
  }

  async function signOut() {
    closePops();
    if (S.dirty) await save(false);
    await sb.auth.signOut();
  }

  // ---------- rich text helpers ----------
  const linkDlg = $("#link-dlg");
  let savedRange = null;
  function openLinkDialog() {
    const sel = window.getSelection();
    savedRange = sel.rangeCount && edRich.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    $("#link-url").value = ""; $("#link-msg").textContent = "";
    showDialog(linkDlg);
    $("#link-url").focus();
  }
  function applyLink() {
    let url = $("#link-url").value.trim();
    if (!url) { $("#link-msg").textContent = "Enter a web address."; $("#link-msg").dataset.kind = "warn"; return; }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
    if (!/^(https?:|mailto:)/i.test(url)) { $("#link-msg").textContent = "Use a web address that starts with https://"; $("#link-msg").dataset.kind = "warn"; return; }
    linkDlg.close();
    edRich.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (savedRange) sel.addRange(savedRange);
    if (!savedRange || savedRange.collapsed) document.execCommand("insertHTML", false, `<a href="${esc(url)}">${esc(url)}</a>`);
    else document.execCommand("createLink", false, url);
    markDirty();
  }

  // ---------- rich text tools ----------
  const COLORS = [["default", "Default"], ["gray", "Grey"], ["red", "Red"], ["orange", "Orange"], ["green", "Green"], ["blue", "Blue"], ["purple", "Purple"], ["pink", "Pink"]];
  const HIGHLIGHTS = [["none", "None"], ["yellow", "Yellow"], ["green", "Green"], ["blue", "Blue"], ["pink", "Pink"], ["purple", "Purple"]];
  const SENTINEL = "#010203"; // temporary colour, swapped for a theme-aware class straight after
  let richRange = null;
  const closestIn = (node, selector) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const hit = el && el.closest(selector);
    return hit && edRich.contains(hit) ? hit : null;
  };
  function saveRichRange() {
    const sel = window.getSelection();
    richRange = sel.rangeCount && edRich.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  }
  function restoreRichRange() {
    edRich.focus();
    if (!richRange) return;
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(richRange);
  }
  function unwrap(el) { el.replaceWith(...el.childNodes); }
  function clearClassesInSelection(prefix) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    $$("[class]", edRich).forEach(el => {
      if ([...el.classList].some(c => c.startsWith(prefix)) && sel.containsNode(el, true) && (el.tagName === "SPAN" || el.tagName === "MARK")) unwrap(el);
    });
  }
  function applyColor(kind, name) {
    restoreRichRange();
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) { toast("Select some text first."); return; }
    const prefix = kind === "color" ? "tc-" : "hl-";
    clearClassesInSelection(prefix);
    if (name !== "default" && name !== "none") {
      document.execCommand("styleWithCSS", false, false);
      document.execCommand("foreColor", false, SENTINEL);
      $$(`font[color="${SENTINEL}"]`, edRich).forEach(f => {
        const el = document.createElement(kind === "color" ? "span" : "mark");
        el.className = prefix + name;
        el.append(...f.childNodes);
        f.replaceWith(el);
      });
    }
    markDirty();
  }
  function openSwatches(btn, kind) {
    const wasOpen = btn.getAttribute("aria-expanded") === "true";
    closePops();
    if (wasOpen) return;
    saveRichRange();
    const m = document.createElement("div");
    m.className = "popover swatches"; m.id = "item-menu";
    m.setAttribute("role", "menu"); m.setAttribute("aria-label", kind === "color" ? "Text colour" : "Highlight");
    (kind === "color" ? COLORS : HIGHLIGHTS).forEach(([name, label]) => {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "menuitem"); b.title = label; b.setAttribute("aria-label", label);
      b.className = "sw";
      b.innerHTML = kind === "color" ? `<span class="tc-${name}">A</span>` : `<mark class="hl-${name}">A</mark>`;
      b.addEventListener("mousedown", e => e.preventDefault());
      b.addEventListener("click", () => { closePops(); applyColor(kind, name); });
      m.append(b);
    });
    document.body.append(m);
    const r = btn.getBoundingClientRect();
    m.style.position = "fixed";
    m.style.top = (r.bottom + 6) + "px";
    m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + "px";
    btn.setAttribute("aria-expanded", "true");
  }
  function toggleChecklist() {
    edRich.focus();
    let ul = closestIn(window.getSelection().anchorNode, "ul");
    if (ul && ul.classList.contains("checks")) { ul.classList.remove("checks"); if (!ul.className) ul.removeAttribute("class"); markDirty(); return; }
    if (!ul) { document.execCommand("insertUnorderedList"); ul = closestIn(window.getSelection().anchorNode, "ul"); }
    if (ul) ul.classList.add("checks");
    markDirty();
  }
  function toggleBlock(tag) {
    edRich.focus();
    const cur = closestIn(window.getSelection().anchorNode, tag);
    document.execCommand("formatBlock", false, cur ? "<p>" : `<${tag}>`);
    markDirty();
  }
  function inlineCode() {
    edRich.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const existing = closestIn(sel.anchorNode, "code");
    if (existing && !existing.closest("pre")) { unwrap(existing); markDirty(); return; }
    if (sel.isCollapsed) { toast("Select some text first."); return; }
    document.execCommand("insertHTML", false, `<code>${esc(sel.toString())}</code>`);
    markDirty();
  }
  function insertTable() {
    edRich.focus();
    const row = `<tr>${"<td><br></td>".repeat(3)}</tr>`;
    document.execCommand("insertHTML", false, `<table class="nt"><thead><tr><th>Column 1</th><th>Column 2</th><th>Column 3</th></tr></thead><tbody>${row}${row}</tbody></table><p><br></p>`);
    markDirty();
  }
  function clearFormatting() {
    edRich.focus();
    document.execCommand("removeFormat");
    clearClassesInSelection("tc-");
    clearClassesInSelection("hl-");
    markDirty();
  }
  // Images are scaled down and compressed on the device, so notes stay small enough to sync.
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const src = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(src);
        const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = c.getContext("2d");
        const webp = c.toDataURL("image/webp", .5).startsWith("data:image/webp");
        if (!webp) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        let q = .82, out = "";
        do { out = c.toDataURL(webp ? "image/webp" : "image/jpeg", q); q -= .12; } while (out.length > 450000 && q > .3);
        if (out.length > 700000) reject(new Error("too large")); else resolve(out);
      };
      img.onerror = () => { URL.revokeObjectURL(src); reject(new Error("unreadable")); };
      img.src = src;
    });
  }
  async function insertImage(file) {
    if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { toast("Choose a PNG, JPEG, WebP or GIF image.", { kind: "warn" }); return; }
    if (file.size > 15 * 1024 * 1024) { toast("That image is over 15 MB. Choose a smaller one.", { kind: "warn" }); return; }
    try {
      const url = await shrinkImage(file);
      restoreRichRange();
      document.execCommand("insertHTML", false, `<img src="${esc(url)}" alt="">`);
      markDirty();
    } catch { toast("Couldn't add that image. Try a different one.", { kind: "warn" }); }
  }
  function onToolbar(b) {
    const act = b.dataset.act;
    if (b.dataset.cmd) { edRich.focus(); document.execCommand(b.dataset.cmd, false, null); markDirty(); return; }
    if (act === "color" || act === "highlight") return openSwatches(b, act);
    if (act === "checks") return toggleChecklist();
    if (act === "table") return insertTable();
    if (act === "image") { saveRichRange(); $("#image-input").click(); return; }
    if (act === "quote") return toggleBlock("blockquote");
    if (act === "code") return inlineCode();
    if (act === "link") return openLinkDialog();
    if (act === "clear") return clearFormatting();
  }

  // ---------- wiring ----------
  titleEl.addEventListener("input", () => { markDirty(); if (!$("#assistant").hidden) renderChat(); });
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || (e.key === "ArrowDown" && titleEl.selectionStart === titleEl.value.length)) {
      e.preventDefault();
      (S.type === "rich" ? edRich : S.type === "tasks" ? $("#task-input") : edPlain).focus();
    }
  });
  edPlain.addEventListener("input", () => { markDirty(); autosize(); renderPreviewSoon(); });
  edPlain.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); document.execCommand("insertText", false, "\t"); }
  });
  edRich.addEventListener("input", markDirty);
  edRich.addEventListener("paste", (e) => {
    const cd = e.clipboardData;
    const imgFile = cd && Array.from(cd.files || []).find(f => f.type.startsWith("image/"));
    if (imgFile) { e.preventDefault(); saveRichRange(); insertImage(imgFile); return; }
    const html = cd && cd.getData("text/html");
    if (html) { e.preventDefault(); document.execCommand("insertHTML", false, sanitize(html)); }
  });
  // Tick a checklist item by clicking its circle.
  edRich.addEventListener("click", (e) => {
    const li = e.target.closest && e.target.closest("ul.checks > li");
    if (!li || !edRich.contains(li)) return;
    if (e.clientX - li.getBoundingClientRect().left > 28) return;
    li.dataset.checked = li.dataset.checked === "true" ? "false" : "true";
    markDirty();
  });
  // Tab moves between table cells; Tab in the last cell adds a row.
  edRich.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const cell = closestIn(window.getSelection().anchorNode, "td, th");
    if (!cell) return;
    e.preventDefault();
    const table = cell.closest("table");
    let cells = $$("th, td", table);
    let i = cells.indexOf(cell) + (e.shiftKey ? -1 : 1);
    if (i >= cells.length) {
      const body = table.tBodies[0] || table;
      const row = body.insertRow();
      for (let c = 0; c < table.rows[0].cells.length; c++) row.insertCell().append(document.createElement("br"));
      cells = $$("th, td", table);
      markDirty();
    }
    const target = cells[Math.max(0, i)];
    const range = document.createRange();
    range.selectNodeContents(target); range.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  });
  $("#image-input").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) insertImage(f); });
  $$("#rich-tools button").forEach(b => {
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", () => onToolbar(b));
  });
  $("#block-style").addEventListener("change", (e) => { edRich.focus(); document.execCommand("formatBlock", false, `<${e.target.value}>`); e.target.value = "p"; markDirty(); });
  $$("#md-tabs button").forEach(b => b.addEventListener("click", () => { S.mdView = b.dataset.md; showEditorFor("markdown"); }));
  $("#task-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("#task-input"), v = inp.value.trim();
    if (!v) return;
    S.tasks.push({ text: v, done: false }); inp.value = "";
    renderTasks(); markDirty(); inp.focus();
  });
  $("#task-clear").addEventListener("click", () => { const before = S.tasks.length; S.tasks = S.tasks.filter(t => !t.done); renderTasks(); markDirty(); toast(`Cleared ${before - S.tasks.length} completed`); });
  $("#link-form").addEventListener("submit", (e) => { e.preventDefault(); applyLink(); });

  $("#btn-library").addEventListener("click", () => setLibrary(!libraryOpen()));
  $("#btn-palette").addEventListener("click", openPalette);
  $("#btn-theme").addEventListener("click", () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length], true));
  $("#btn-new").addEventListener("click", () => { buildNewMenu(); togglePop($("#btn-new"), $("#menu-new")); });
  $("#btn-more").addEventListener("click", () => { buildMoreMenu(); togglePop($("#btn-more"), $("#menu-more")); });
  $("#btn-typo").addEventListener("click", () => togglePop($("#btn-typo"), $("#typo-pop")));
  $$("#pref-font button").forEach(b => b.addEventListener("click", () => { ls.set(KEY.font, b.dataset.v); applyTypePrefs(); }));
  $$("#pref-size button").forEach(b => b.addEventListener("click", () => { ls.set(KEY.size, b.dataset.v); applyTypePrefs(); }));
  $("#btn-share").addEventListener("click", openShare);
  $("#btn-exit-focus").addEventListener("click", () => setFocus(false));
  $("#btn-signin").addEventListener("click", () => openAuth("signin"));
  $("#btn-acct").addEventListener("click", () => togglePop($("#btn-acct"), $("#acct-menu")));
  $("#btn-signout").addEventListener("click", signOut);
  $("#btn-change-pw").addEventListener("click", () => openAuth("reset"));
  $("#btn-delete-acct").addEventListener("click", openDeleteAccount);
  $("#del-form").addEventListener("submit", (e) => { e.preventDefault(); deleteAccount(); });

  $("#search").addEventListener("input", (e) => { S.query = e.target.value; renderList(); });
  $$("#filters button").forEach(b => b.addEventListener("click", () => { S.filter = b.dataset.filter; renderList(); }));
  $("#sort").addEventListener("change", (e) => { S.sort = e.target.value; ls.set(KEY.sort, S.sort); renderList(); });

  $("#auth-form").addEventListener("submit", (e) => { e.preventDefault(); submitAuth(); });
  $$("#auth-tabs button").forEach(b => b.addEventListener("click", () => { const em = $("#auth-email").value; setAuthMode(b.dataset.mode); $("#auth-email").value = em; }));
  $("#auth-forgot").addEventListener("click", () => { const em = $("#auth-email").value; setAuthMode("forgot"); $("#auth-email").value = em; $("#auth-email").focus(); });
  $("#auth-back").addEventListener("click", () => { const em = $("#auth-email").value; setAuthMode("signin"); $("#auth-email").value = em; });
  $("#auth-show").addEventListener("change", (e) => { const t = e.target.checked ? "text" : "password"; $("#auth-password").type = t; $("#auth-confirm").type = t; });
  $("#btn-google").addEventListener("click", () => sb && sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } }));

  $("#unlock-form").addEventListener("submit", (e) => { e.preventDefault(); const pw = $("#unlock-pw").value; if (pw) loadShared(pw); });
  $("#shared-close").addEventListener("click", () => closeShared(false));
  $("#shared-copy").addEventListener("click", () => {
    const n = S.shared; if (!n) return;
    closeShared(true);
    startNew(n.type || "plain", { title: ((n.title || "Shared note") + " (copy)").slice(0, 200), body: n.body, tasks: n.tasks || [] });
  });

  $("#assist-close").addEventListener("click", closeAssistant);
  $$("#chat-chips button").forEach(b => b.addEventListener("click", () => ask(b.textContent)));
  $("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#chat-input").value; $("#chat-input").value = ""; ask(v); });
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); } });
  $("#chat-stop").addEventListener("click", () => { if (S.chatCtl) S.chatCtl.abort(); });

  $("#pal-q").addEventListener("input", renderPalette);
  $("#pal-q").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); palIndex = Math.min(palItems.length - 1, palIndex + 1); markPal(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palIndex = Math.max(0, palIndex - 1); markPal(); }
    else if (e.key === "Enter") { e.preventDefault(); runPal(palIndex); }
  });

  $("#file-import").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); });
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  workspace.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; dragDepth++; $("#drop-hint").hidden = false; });
  workspace.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#drop-hint").hidden = true; });
  workspace.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  workspace.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $("#drop-hint").hidden = true;
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (f.type.startsWith("image/") && S.type === "rich") { richRange = null; insertImage(f); }
    else importFile(f);
  });
  workspace.addEventListener("scroll", () => $("#doc-bar").classList.toggle("scrolled", workspace.scrollTop > 4), { passive: true });

  if (CFG.contactEmail) {
    const r = $("#foot-report");
    r.href = `mailto:${CFG.contactEmail}?subject=${encodeURIComponent("Abuse report")}`;
    r.hidden = false;
  }
  $("#foot-keys").addEventListener("click", (e) => { e.preventDefault(); openKeys(); });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-wrap") && !e.target.closest("#item-menu") && !e.target.closest(".n-more") && !e.target.closest(".fmt [aria-haspopup]")) closePops();
  });
  document.addEventListener("keydown", (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === "k") { e.preventDefault(); palette.open ? palette.close() : openPalette(); return; }
    if (mod && k === "s") { e.preventDefault(); save(true); return; }
    if (mod && e.shiftKey && k === "f") { e.preventDefault(); setFocus(!document.body.classList.contains("focus")); return; }
    if (mod && e.key === "\\") { e.preventDefault(); setLibrary(!libraryOpen()); return; }
    if (mod && e.key === "/") { e.preventDefault(); openKeys(); return; }
    if (e.altKey && !mod && e.code === "KeyN") { e.preventDefault(); startNew("rich"); return; }
    if (e.key === "Escape") {
      if ($$("dialog[open]").length) return;   // the dialog handles its own Escape
      if ($$(".popover:not([hidden])").length || $("#item-menu")) { closePops(); return; }
      if (document.body.classList.contains("focus")) { setFocus(false); return; }
      if (mqMobile.matches && libraryOpen()) setLibrary(false);
    }
  });
  mqMobile.addEventListener("change", () => {
    document.body.classList.remove("lib-open");
    if (scrim) { scrim.remove(); scrim = null; }
    document.body.classList.toggle("lib-hidden", !mqMobile.matches && ls.get(KEY.lib) === "hidden");
    $("#btn-library").setAttribute("aria-expanded", String(libraryOpen()));
  });
  window.addEventListener("resize", debounce(autosize, 120));
  window.addEventListener("online", () => { S.online = true; updateAccountUI(); flushPending(); if (S.dirty) save(false); });
  window.addEventListener("offline", () => { S.online = false; updateAccountUI(); });
  window.addEventListener("beforeunload", (e) => { if (S.dirty) { save(false); e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && S.dirty) save(false);
    if (document.visibilityState === "visible" && S.mode === "cloud" && !S.dirty) refreshCloud();
  });
  setInterval(() => { if (!S.dirty) renderMeta(); }, 60000);

  // ---------- boot ----------
  applyTheme(theme);
  applyTypePrefs();
  if (!mqMobile.matches && ls.get(KEY.lib) === "hidden") document.body.classList.add("lib-hidden");
  $("#btn-library").setAttribute("aria-expanded", String(libraryOpen()));
  openMostRecentOrExample();
  updateAccountUI(); renderList(); renderBanners();
  handleShareParam();

  if (sb) {
    sb.auth.onAuthStateChange((event, session) => {
      // Deferred: supabase-js advises against awaiting other calls inside this callback.
      setTimeout(() => {
        if (event === "PASSWORD_RECOVERY") openAuth("reset");
        const user = session && session.user;
        if (user && (!S.user || S.user.id !== user.id)) enterCloud(user);
        else if (!user && S.mode === "cloud") leaveCloud();
      }, 0);
    });
  }

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => { /* offline support is optional */ }));
  }
})();
