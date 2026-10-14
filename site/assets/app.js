(() => {
  "use strict";

  const CFG = Object.assign({
    brandName: "Quillnote", tagline: "", supabaseUrl: "", supabaseAnonKey: "",
    aiEnabled: false, googleSignIn: false, contactEmail: "", passwordResetEmails: false,
  }, window.QUILLNOTE_CONFIG || {});
  const BRAND = CFG.brandName || "Quillnote";
  const LS_NOTES = "quillnote.notes.v1";
  const TYPES = { plain: "Plain text", rich: "Rich text", markdown: "Markdown", tasks: "Task list" };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  // ---------- Supabase ----------
  const sb = (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase)
    ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
    : null;

  // ---------- safe storage ----------
  const store = (kind) => ({
    get(k) { try { return window[kind].getItem(k); } catch { return null; } },
    set(k, v) { try { window[kind].setItem(k, v); return true; } catch { return false; } },
    del(k) { try { window[kind].removeItem(k); } catch {} },
  });
  const ls = store("localStorage"), ss = store("sessionStorage");
  const loadLocalNotes = () => {
    try { const a = JSON.parse(ls.get(LS_NOTES) || "[]"); return Array.isArray(a) ? a.filter(n => n && n.id) : []; }
    catch { return []; }
  };

  // ---------- state ----------
  const S = {
    mode: "guest", user: null, cloudReady: false,
    notes: loadLocalNotes(),
    currentId: null, loadedAt: 0, type: "plain", tasks: [], mdView: "write",
    isExample: false, dirty: false,
    sort: ls.get("quillnote.sort") === "title" ? "title" : "updated", query: "",
    confirmDelete: null, storageBlocked: false,
    guestNoticeDismissed: ss.get("quillnote.guestNotice") === "off",
    showGuestNotice: false, notice: null, chat: [], chatCtl: null, shared: null,
  };

  // ---------- elements ----------
  const titleEl = $("#note-title"), edPlain = $("#ed-plain"), edRich = $("#ed-rich"),
        mdPreview = $("#md-preview"), edTasks = $("#ed-tasks"), statusEl = $("#status");

  // ---------- helpers ----------
  const newId = () => (crypto.randomUUID ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const fmtAgo = (t) => {
    const s = (t - Date.now()) / 1000, a = Math.abs(s);
    if (a < 45) return "just now";
    if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
    if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
    if (a < 86400 * 7) return rtf.format(Math.round(s / 86400), "day");
    return new Date(t).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  };

  function sanitize(html) {
    if (window.DOMPurify) return window.DOMPurify.sanitize(String(html || ""), { USE_PROFILES: { html: true } });
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    doc.querySelectorAll("script,style,iframe,object,embed,link,meta,form").forEach(e => e.remove());
    doc.querySelectorAll("*").forEach(el => {
      for (const at of Array.from(el.attributes)) {
        if (/^on/i.test(at.name) || (/^(href|src|xlink:href)$/i.test(at.name) && /^\s*javascript:/i.test(at.value))) el.removeAttribute(at.name);
      }
    });
    return doc.body.innerHTML;
  }
  function mdToHtml(src) {
    if (window.marked && typeof window.marked.parse === "function") {
      try { return sanitize(window.marked.parse(String(src || ""), { gfm: true, breaks: true })); } catch {}
    }
    return "<pre>" + esc(src || "") + "</pre>";
  }
  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(sanitize(html), "text/html");
    doc.querySelectorAll("br").forEach(b => b.replaceWith("\n"));
    doc.querySelectorAll("p,div,li,h1,h2,h3,h4,h5,h6,blockquote,pre,tr").forEach(el => el.append("\n"));
    doc.querySelectorAll("li").forEach(li => li.prepend("- "));
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function plainText(n) {
    if (!n) return "";
    if (n.type === "rich") return htmlToText(n.body);
    if (n.type === "tasks") return (n.tasks || []).map(t => (t.done ? "[x] " : "[ ] ") + t.text).join("\n");
    return n.body || "";
  }

  // DB row <-> note
  const toRow = (n) => ({
    id: n.id, user_id: S.user.id, title: n.title || "", type: n.type, body: n.body || "",
    tasks: n.type === "tasks" ? (n.tasks || []) : null, is_public: !!n.isPublic,
    created_at: new Date(n.createdAt).toISOString(), updated_at: new Date(n.updatedAt).toISOString(),
  });
  const fromRow = (r) => ({
    id: r.id, title: r.title, type: r.type, body: r.body, tasks: r.tasks, isPublic: r.is_public,
    createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at),
  });

  // ---------- branding ----------
  $$("[data-brand]").forEach(el => { el.textContent = BRAND; });
  $$("[data-tagline]").forEach(el => { if (CFG.tagline) el.textContent = CFG.tagline; else el.hidden = true; });
  document.title = `${BRAND} · free online notepad`;

  // ---------- editor ----------
  function showEditorFor(type) {
    S.type = type;
    $("#type-chip").textContent = TYPES[type];
    $("#rich-tools").hidden = type !== "rich";
    $("#md-tabs").hidden = type !== "markdown";
    edRich.hidden = type !== "rich";
    edTasks.hidden = type !== "tasks";
    const preview = type === "markdown" && S.mdView === "preview";
    edPlain.hidden = !(type === "plain" || (type === "markdown" && !preview));
    mdPreview.hidden = !preview;
    if (preview) mdPreview.innerHTML = mdToHtml(edPlain.value);
    $$("#md-tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.md === S.mdView)));
    edPlain.placeholder = type === "markdown"
      ? "# Heading\n\nWrite in Markdown: **bold**, _italic_, - lists, [links](https://…)"
      : "Start typing. Your note saves as you go.";
  }

  function loadIntoEditor(n) {
    S.mdView = "write";
    titleEl.value = n.title || "";
    edPlain.value = (n.type === "plain" || n.type === "markdown") ? (n.body || "") : "";
    edRich.innerHTML = n.type === "rich" ? sanitize(n.body) : "";
    S.tasks = n.type === "tasks" ? (n.tasks || []).map(t => ({ text: String(t.text || ""), done: !!t.done })) : [];
    showEditorFor(n.type || "plain");
    renderTasks();
    updateCounts();
    renderVis();
    renderDownloadMenu();
  }

  function getBody() {
    if (S.type === "rich") return edRich.innerHTML;
    if (S.type === "tasks") return S.tasks.map(t => (t.done ? "[x] " : "[ ] ") + t.text).join("\n");
    return edPlain.value;
  }
  function collect() {
    return {
      title: titleEl.value.trim(), type: S.type, body: getBody(),
      tasks: S.type === "tasks" ? S.tasks.map(t => ({ text: t.text, done: !!t.done })) : null,
    };
  }
  const isEmpty = (n) => !n.title && !plainText(n).trim();

  function updateCounts() {
    const text = plainText(collect());
    const words = (text.match(/\S+/g) || []).length;
    const mins = Math.max(1, Math.round(words / 230));
    $("#counts").textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} chars${words ? ` · ${mins} min read` : ""}`;
  }

  function setStatus(msg, kind = "") { statusEl.textContent = msg; statusEl.dataset.kind = kind; }

  let autoT = null;
  function markDirty() {
    S.dirty = true;
    S.isExample = false;
    setStatus("Unsaved changes");
    updateCounts();
    clearTimeout(autoT);
    autoT = setTimeout(() => save(false), 1500);
  }

  // tasks
  function renderTasks() {
    const ul = $("#task-list");
    ul.textContent = "";
    S.tasks.forEach((t, i) => {
      const li = document.createElement("li");
      li.className = t.done ? "done" : "";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = t.done; cb.setAttribute("aria-label", "Done");
      cb.addEventListener("change", () => { t.done = cb.checked; li.className = t.done ? "done" : ""; meter(); markDirty(); });
      const tx = document.createElement("input");
      tx.type = "text"; tx.value = t.text; tx.setAttribute("aria-label", "Task");
      tx.addEventListener("input", () => { t.text = tx.value; markDirty(); });
      tx.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#task-input").focus(); } });
      const x = document.createElement("button");
      x.type = "button"; x.className = "x"; x.textContent = "✕"; x.title = "Remove task"; x.setAttribute("aria-label", "Remove task");
      x.addEventListener("click", () => { S.tasks.splice(i, 1); renderTasks(); markDirty(); });
      li.append(cb, tx, x);
      ul.append(li);
    });
    meter();
  }
  function meter() {
    const done = S.tasks.filter(t => t.done).length, all = S.tasks.length;
    $("#task-progress").textContent = `${done} of ${all} done`;
    $("#task-fill").style.width = all ? (done / all * 100) + "%" : "0";
  }

  // ---------- persistence ----------
  function writeLocal(arr) {
    const ok = ls.set(LS_NOTES, JSON.stringify(arr));
    if (!ok && !S.storageBlocked) { S.storageBlocked = true; renderBanners(); }
    return ok;
  }
  function upsert(arr, n) { const i = arr.findIndex(x => x.id === n.id); if (i >= 0) arr[i] = n; else arr.push(n); }

  async function putNote(n) {
    if (JSON.stringify(n).length > 480000) throw { code: "too_big" };
    if (S.mode === "cloud") {
      const { error } = await sb.from("notes").upsert(toRow(n));
      if (error) throw error;
    } else {
      writeLocal([...S.notes.filter(x => x.id !== n.id), n]);
    }
    upsert(S.notes, n);
  }

  function errCopy(e) {
    const c = e && e.code;
    if (c === "too_big" || c === "23514") return "This note is too large to save. Split it into two notes.";
    if (e && (e.status === 401 || c === "PGRST301")) return "Your session ended. Sign in again, then press Save.";
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "You're offline. Your changes will save when you press Save again online.";
    return "Couldn't save just now. Check your connection and press Save.";
  }

  let saving = null;
  async function save(manual) {
    clearTimeout(autoT);
    if (saving) { await saving; if (!manual && !S.dirty) return; }
    const data = collect();
    if (isEmpty(data)) { if (manual) setStatus("Add a title or some text first.", "warn"); return; }
    if (!manual && !S.dirty) return;
    const now = Date.now();
    const prev = S.notes.find(x => x.id === S.currentId);
    const n = { ...data, id: S.currentId || newId(), createdAt: prev ? prev.createdAt : now, updatedAt: now, isPublic: prev ? !!prev.isPublic : false };
    S.currentId = n.id; S.loadedAt = now; S.dirty = false; S.isExample = false;
    setStatus("Saving…");
    saving = putNote(n).then(() => {
      setStatus("Saved · " + fmtTime(now), "ok");
      if (S.mode === "guest" && !S.guestNoticeDismissed && !S.showGuestNotice) { S.showGuestNotice = true; renderBanners(); }
      renderList(); renderVis(); renderDownloadMenu();
    }).catch((e) => { S.dirty = true; setStatus(errCopy(e), "warn"); })
      .finally(() => { saving = null; });
    return saving;
  }

  async function startNew(type, seed = {}) {
    if (S.dirty) await save(false);
    S.currentId = null; S.loadedAt = 0; S.isExample = false; S.dirty = false;
    loadIntoEditor({ type, title: seed.title || "", body: seed.body || "", tasks: seed.tasks || [] });
    resetChat(); renderList(); closeShare();
    if (seed.title || seed.body || (seed.tasks && seed.tasks.length)) markDirty();
    else setStatus(`New ${TYPES[type].toLowerCase()} note. It saves as you type.`);
    (type === "rich" ? edRich : type === "tasks" ? $("#task-input") : titleEl).focus();
  }

  async function openNote(id) {
    if (id === S.currentId) return;
    if (S.dirty) await save(false);
    const n = S.notes.find(x => x.id === id);
    if (!n) return;
    S.currentId = id; S.loadedAt = n.updatedAt; S.dirty = false; S.isExample = false;
    loadIntoEditor(n);
    setStatus("Saved · " + fmtAgo(n.updatedAt), "ok");
    resetChat(); closeShare(); renderList();
    if (window.matchMedia("(max-width: 900px)").matches) titleEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openMostRecentOrExample() {
    const recent = S.notes.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      S.currentId = recent.id; S.loadedAt = recent.updatedAt; S.isExample = false;
      loadIntoEditor(recent);
      setStatus("Saved · " + fmtAgo(recent.updatedAt), "ok");
    } else {
      S.currentId = null; S.loadedAt = 0; S.isExample = true;
      loadIntoEditor({
        type: "plain", title: "Saturday errands",
        body: "- Return the library books (due on the 18th)\n- Collect the bike from the repair shop, closes at 4\n- Groceries: oats, lemons, rice, coffee filters\n\nCall the plumber about the dripping kitchen tap.\nBook a table for Sunday lunch, 6 people.",
      });
      setStatus("Example note. Edit it to make it yours, or start a new one.");
    }
    S.dirty = false;
    resetChat();
  }

  async function deleteNote(id) {
    const n = S.notes.find(x => x.id === id);
    S.confirmDelete = null;
    if (!n) return;
    try {
      if (S.mode === "cloud") {
        const { error } = await sb.from("notes").delete().eq("id", id);
        if (error) throw error;
      }
      S.notes = S.notes.filter(x => x.id !== id);
      if (S.mode === "guest") writeLocal(S.notes);
      if (id === S.currentId) { S.dirty = false; await startNew("plain"); setStatus("Note deleted."); }
      renderList();
    } catch { setStatus("Couldn't delete that note. Try again in a moment.", "warn"); }
  }

  // ---------- notes list ----------
  function renderList() {
    const ul = $("#note-list");
    ul.textContent = "";
    $("#note-count").textContent = S.notes.length;
    $$(".sortrow button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sort === S.sort)));
    if (S.mode === "cloud" && !S.cloudReady) { ul.innerHTML = `<li class="empty">Loading your notes…</li>`; return; }
    const q = S.query.trim().toLowerCase();
    const rows = S.notes.map(n => ({ n, text: plainText(n) }))
      .filter(r => !q || (r.n.title || "").toLowerCase().includes(q) || r.text.toLowerCase().includes(q));
    rows.sort(S.sort === "title"
      ? (a, b) => (a.n.title || "Untitled").localeCompare(b.n.title || "Untitled", undefined, { sensitivity: "base" })
      : (a, b) => b.n.updatedAt - a.n.updatedAt);
    if (!S.notes.length) { ul.innerHTML = `<li class="empty">No saved notes yet. Write something on the left and it saves as you type.</li>`; return; }
    if (!rows.length) { ul.innerHTML = `<li class="empty">No notes match “${esc(S.query.trim())}”.</li>`; return; }
    for (const { n, text } of rows) {
      const li = document.createElement("li");
      li.className = "n-item" + (n.id === S.currentId ? " current" : "");
      if (S.confirmDelete === n.id) {
        li.innerHTML = `<div class="n-confirm"><span>Delete “<span class="t"></span>”?</span><button class="btn danger" type="button" data-act="yes">Delete</button><button class="btn" type="button" data-act="no">Keep</button></div>`;
        $(".t", li).textContent = n.title || "Untitled";
        $('[data-act="yes"]', li).addEventListener("click", () => deleteNote(n.id));
        $('[data-act="no"]', li).addEventListener("click", () => { S.confirmDelete = null; renderList(); });
      } else {
        li.innerHTML = `<button class="n-open" type="button"><span class="n-top"><span class="n-title"></span></span><span class="n-snip"></span><span class="n-meta"></span></button><button class="n-del" type="button" title="Delete note" aria-label="Delete note">✕</button>`;
        $(".n-title", li).textContent = n.title || "Untitled";
        if (n.isPublic) { const b = document.createElement("span"); b.className = "n-badge"; b.textContent = "Shared"; $(".n-top", li).append(b); }
        $(".n-snip", li).textContent = text.replace(/\s+/g, " ").trim().slice(0, 90) || "Empty note";
        $(".n-meta", li).textContent = `${TYPES[n.type] || "Note"} · ${fmtAgo(n.updatedAt)}`;
        $(".n-open", li).addEventListener("click", () => openNote(n.id));
        $(".n-del", li).addEventListener("click", () => { S.confirmDelete = n.id; renderList(); });
      }
      ul.append(li);
    }
  }

  // ---------- visibility + sharing ----------
  const ICON_LOCK = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>`;
  const ICON_GLOBE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>`;
  const ICON_BROWSER = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/></svg>`;
  function renderVis() {
    const btn = $("#vis-btn");
    const n = S.notes.find(x => x.id === S.currentId);
    if (S.mode === "guest") btn.innerHTML = ICON_BROWSER + "<span>Guest note · this browser only</span>";
    else if (n && n.isPublic) btn.innerHTML = ICON_GLOBE + "<span>Shared · anyone with the link</span>";
    else btn.innerHTML = ICON_LOCK + "<span>Private · only you</span>";
  }

  const shareUrl = (id) => `${location.origin}${location.pathname}?s=${id}`;
  function closeShare() { $("#share-panel").hidden = true; $("#btn-share").setAttribute("aria-expanded", "false"); }
  async function openShare() {
    const p = $("#share-panel");
    if (!p.hidden) { closeShare(); return; }
    $("#btn-share").setAttribute("aria-expanded", "true");
    p.hidden = false;
    if (S.mode === "guest") {
      p.innerHTML = `<h3>Sharing needs a free account</h3><p class="small">Guest notes live only in this browser, so there's nothing for a link to point to. Create a free account and your notes move into it. Then you can share any of them by link.</p><div class="link-row"><button class="btn primary" type="button" id="share-signin"></button><button class="btn" type="button" id="share-close">Close</button></div>`;
      $("#share-signin").textContent = sb ? "Create free account" : "Accounts aren't set up yet";
      $("#share-signin").disabled = !sb;
      $("#share-signin").addEventListener("click", () => { closeShare(); openAuth(); });
      $("#share-close").addEventListener("click", closeShare);
      return;
    }
    if (isEmpty(collect())) {
      p.innerHTML = `<h3>Share this note</h3><p class="small">Write something first. A note needs a title or some text before it can be shared.</p><div><button class="btn" type="button" id="share-close">Close</button></div>`;
      $("#share-close").addEventListener("click", closeShare);
      return;
    }
    if (!S.currentId || S.dirty) await save(true);
    renderSharePanel();
  }
  function renderSharePanel() {
    const p = $("#share-panel");
    const n = S.notes.find(x => x.id === S.currentId);
    if (!n) return;
    p.innerHTML = `<h3>Share this note</h3>
      <label class="switch"><input type="checkbox" id="share-toggle" ${n.isPublic ? "checked" : ""}> Anyone with the link can read this note</label>
      <div ${n.isPublic ? "" : "hidden"}>
        <div class="link-row"><input id="share-url" type="text" readonly aria-label="Share link"><button class="btn primary" type="button" id="share-copy">Copy link</button></div>
        <p class="small muted" id="share-hint">Readers see a read-only copy that updates whenever you save.</p>
      </div>
      <p class="small muted" ${n.isPublic ? "hidden" : ""}>Private. Only you can see this note.</p>`;
    $("#share-url").value = shareUrl(n.id);
    $("#share-toggle").addEventListener("change", (e) => setPublic(n.id, e.target.checked));
    $("#share-copy").addEventListener("click", () => {
      const inp = $("#share-url");
      const done = () => { $("#share-copy").textContent = "Copied"; };
      if (navigator.clipboard) navigator.clipboard.writeText(inp.value).then(done).catch(() => { inp.select(); });
      else { inp.select(); }
    });
  }
  async function setPublic(id, on) {
    const n = S.notes.find(x => x.id === id);
    if (!n) return;
    const { error } = await sb.from("notes").update({ is_public: on }).eq("id", id);
    if (error) setStatus("Couldn't change sharing. Try again in a moment.", "warn");
    else {
      upsert(S.notes, { ...n, isPublic: on });
      setStatus(on ? "Link sharing is on." : "Link sharing is off. The old link no longer works.", "ok");
    }
    renderSharePanel(); renderVis(); renderList();
  }

  // ---------- shared view (?s=<id>) ----------
  function renderReadOnly(n, host) {
    host.textContent = "";
    host.className = "";
    if (n.type === "rich") { host.className = "prose"; host.innerHTML = sanitize(n.body); }
    else if (n.type === "markdown") { host.className = "prose"; host.innerHTML = mdToHtml(n.body); }
    else if (n.type === "tasks") {
      const ul = document.createElement("ul"); ul.className = "ro-tasks";
      (n.tasks || []).forEach(t => { const li = document.createElement("li"); li.textContent = t.text; if (t.done) li.className = "done"; ul.append(li); });
      host.append(ul);
    } else { const d = document.createElement("div"); d.className = "plain-ro"; d.textContent = n.body || ""; host.append(d); }
  }
  async function handleShareParam() {
    const id = new URLSearchParams(location.search).get("s");
    const view = $("#shared-view");
    if (!id) { view.hidden = true; return; }
    view.hidden = false;
    $("#shared-copy").hidden = true;
    $("#shared-report").hidden = true;
    $("#shared-meta").textContent = "";
    $("#shared-body").textContent = "";
    if (!UUID_RE.test(id) || !sb) {
      $("#shared-title").textContent = "This link isn't complete";
      $("#shared-body").textContent = "Ask the person who shared it to copy the link again.";
      return;
    }
    $("#shared-title").textContent = "Loading shared note…";
    const { data, error } = await sb.rpc("get_shared_note", { note_id: id });
    if (error) {
      $("#shared-title").textContent = "Couldn't load this note";
      $("#shared-body").textContent = "Check your connection and reload the page.";
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      $("#shared-title").textContent = "This note isn't shared anymore";
      $("#shared-body").textContent = "The owner turned off link sharing or deleted the note. Ask them for a new link.";
      return;
    }
    const n = { title: row.title, type: row.type, body: row.body, tasks: row.tasks, updatedAt: Date.parse(row.updated_at) };
    S.shared = n;
    $("#shared-title").textContent = n.title || "Untitled";
    $("#shared-meta").textContent = `${TYPES[n.type] || "Note"} · updated ${fmtAgo(n.updatedAt)}`;
    renderReadOnly(n, $("#shared-body"));
    $("#shared-copy").hidden = false;
    if (CFG.contactEmail) {
      const r = $("#shared-report");
      r.href = `mailto:${CFG.contactEmail}?subject=${encodeURIComponent("Report shared note " + id)}`;
      r.hidden = false;
    }
  }
  function closeShared() {
    $("#shared-view").hidden = true;
    S.shared = null;
    history.replaceState(null, "", location.pathname);
  }

  // ---------- banners ----------
  function renderBanners() {
    const host = $("#banners");
    host.textContent = "";
    if (S.notice) host.append(banner(S.notice.kind || "", S.notice.title, S.notice.text, [["Got it", () => { S.notice = null; renderBanners(); }]]));
    if (S.storageBlocked) {
      host.append(banner("warn", "This browser is blocking storage",
        sb ? "Guest notes can't be kept after you close this tab. Create a free account to keep them, or allow site data for this site."
           : "Notes can't be kept after you close this tab. Download anything you want to keep, or allow site data for this site.", []));
    }
    if (S.mode === "guest" && S.showGuestNotice && !S.storageBlocked) {
      const actions = [];
      if (sb) actions.push(["Create free account", openAuth, true]);
      actions.push(["Got it", () => { S.showGuestNotice = false; S.guestNoticeDismissed = true; ss.set("quillnote.guestNotice", "off"); renderBanners(); }]);
      host.append(banner("", "Saved as a guest",
        sb ? "This note lives in this browser and waits here for you until cookies or site data are cleared. Make a free account to open your notes on any device without risk of losing them. Everything you've saved here comes with you."
           : "This note lives in this browser and waits here for you until cookies or site data are cleared.",
        actions));
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
      b.type = "button"; b.className = "btn" + (primary ? " primary" : ""); b.textContent = label;
      b.addEventListener("click", fn);
      $(".b-actions", d).append(b);
    }
    return d;
  }

  // ---------- accounts ----------
  function updateAccountUI() {
    const cloud = S.mode === "cloud";
    $("#mode-chip").dataset.mode = S.mode;
    $("#mode-text").textContent = cloud ? "Signed in · saved to your account" : "Guest · saved in this browser";
    $("#btn-signin").hidden = !sb || cloud;
    $("#acct").hidden = !cloud;
    $("#acct-email").textContent = cloud ? (S.user.email || "your account") : "";
    $("#btn-ai").hidden = !CFG.aiEnabled || !sb;
    $("#tab-chat").hidden = !CFG.aiEnabled || !sb;
    renderVis();
  }

  // Email + password accounts. Modes: signup, signin, forgot (request a reset email), reset (choose a new password).
  // With passwordResetEmails off, the site never sends email: accounts work straight away and
  // there is no emailed reset, so the copy asks people to keep their password safe.
  const NO_RESET_NOTE = CFG.contactEmail
    ? ` Passwords can't be reset by email, so keep yours somewhere safe. If you're locked out, write to ${CFG.contactEmail}.`
    : " Passwords can't be reset by email, so keep yours somewhere safe.";
  const AUTH_MODES = {
    signup: { h: "Create a free account", sub: "Use your email and a password of at least 8 characters. You can start using your account straight away, and notes you saved as a guest move into it automatically." + (CFG.passwordResetEmails ? "" : NO_RESET_NOTE), submit: "Create account", email: true, pw: true, confirm: true, tabs: true },
    signin: { h: "Sign in", sub: "Notes you saved as a guest on this device move into your account when you sign in." + (CFG.passwordResetEmails ? "" : NO_RESET_NOTE), submit: "Sign in", email: true, pw: true, forgot: CFG.passwordResetEmails, tabs: true },
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
    setAuthMode(typeof mode === "string" ? mode : "signup");
    const p = $("#auth-panel");
    p.hidden = false;
    p.scrollIntoView({ behavior: "smooth", block: "start" });
    (authMode === "reset" ? $("#auth-password") : $("#auth-email")).focus();
  }
  function closeAuth() { $("#auth-panel").hidden = true; }
  const redirectTo = () => location.origin + location.pathname;

  function authErrorCopy(err) {
    const code = (err && err.code) || "", msg = (err && err.message) || "";
    if (code === "invalid_credentials" || /invalid login credentials/i.test(msg)) return "Wrong email or password.";
    if (code === "email_not_confirmed" || /not confirmed/i.test(msg)) return "This account hasn't been confirmed yet. Open the confirmation link sent to your email, then sign in.";
    if (code === "user_already_exists" || /already registered/i.test(msg)) return "An account with this email already exists. Sign in instead.";
    if (code === "weak_password" || /password/i.test(msg) && /weak|short|least/i.test(msg)) return "That password is too easy to guess. Use a longer one with a mix of letters, numbers and symbols.";
    if (code === "same_password") return "That's your current password. Choose a different one.";
    if (err && err.status === 429 || /rate limit/i.test(msg)) return "Too many attempts. Wait a few minutes and try again.";
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
    authMsg("Working…");
    try {
      if (authMode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password: pw });
        if (error) return authMsg(authErrorCopy(error), "warn");
        // With email confirmation on, an existing address comes back as a user with no identities.
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          setAuthMode("signin"); $("#auth-email").value = email;
          return authMsg("An account with this email already exists. Sign in instead.", "warn");
        }
        if (!data.session) {
          // Only happens if "Confirm email" is switched back on in Supabase.
          setAuthMode("signin"); $("#auth-email").value = email;
          return authMsg(`Account created. Open the confirmation link sent to ${email}, then sign in here.`, "ok");
        }
        authMsg("Account created. You're signed in.", "ok");   // onAuthStateChange takes it from here
      } else if (authMode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password: pw });
        if (error) return authMsg(authErrorCopy(error), "warn");
        authMsg("Signed in.", "ok");
      } else if (authMode === "forgot") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
        if (error) return authMsg(authErrorCopy(error), "warn");
        authMsg(`If an account exists for ${email}, a reset link is on its way. Open it on this device.`, "ok");
      } else if (authMode === "reset") {
        const { error } = await sb.auth.updateUser({ password: pw });
        if (error) return authMsg(authErrorCopy(error), "warn");
        closeAuth();
        setStatus("Password updated.", "ok");
      }
    } catch {
      authMsg("Something went wrong. Check your connection and try again.", "warn");
    } finally {
      btn.disabled = false;
    }
  }

  async function enterCloud(user) {
    if (S.dirty) await save(false);
    const guestNotes = loadLocalNotes();
    const openGuest = S.notes.find(x => x.id === S.currentId);
    S.mode = "cloud"; S.user = user; S.cloudReady = false; S.showGuestNotice = false;
    closeAuth(); updateAccountUI(); renderBanners(); renderList();

    // Move guest notes into the account (same ids, so a retry never duplicates).
    if (guestNotes.length) {
      const { error } = await sb.from("notes").upsert(guestNotes.map(n => toRow({ ...n, isPublic: false })));
      if (error) {
        S.notice = { kind: "warn", title: "Your guest notes are still in this browser", text: "They couldn't be moved into your account just now. Reload the page to try again." };
      } else {
        ls.del(LS_NOTES);
        const k = guestNotes.length;
        S.notice = { title: `Moved ${k} ${k === 1 ? "note" : "notes"} into your account`, text: "The notes you saved as a guest are now private to you and available wherever you sign in." };
      }
      renderBanners();
    }
    await refreshCloud(openGuest ? openGuest.id : S.currentId);
  }

  async function refreshCloud(keepId) {
    const { data, error } = await sb.from("notes")
      .select("id,title,type,body,tasks,is_public,created_at,updated_at")
      .order("updated_at", { ascending: false }).limit(1000);
    if (error) { setStatus("Couldn't load your notes. Reload the page to try again.", "warn"); return; }
    S.cloudReady = true;
    S.notes = data.map(fromRow);
    const cur = S.notes.find(x => x.id === (keepId || S.currentId));
    if (cur && !S.dirty) {
      if (cur.updatedAt > S.loadedAt || cur.id !== S.currentId) { S.currentId = cur.id; S.loadedAt = cur.updatedAt; loadIntoEditor(cur); setStatus("Saved · " + fmtAgo(cur.updatedAt), "ok"); }
    } else if (!cur && !S.dirty && !S.isExample && S.currentId) {
      openMostRecentOrExample();
    } else if (!S.currentId && S.isExample && S.notes.length) {
      openMostRecentOrExample();
    }
    renderList(); renderVis();
  }

  function leaveCloud() {
    S.mode = "guest"; S.user = null; S.cloudReady = false; S.notice = null;
    S.notes = loadLocalNotes();
    S.dirty = false;
    openMostRecentOrExample();
    updateAccountUI(); renderBanners(); renderList();
  }

  // ---------- downloads ----------
  const slug = (s) => (s || "note").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "note";
  const wrapHtml = (title, inner) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#16202c}</style></head><body><h1>${esc(title)}</h1>${inner}</body></html>`;
  const wrapWord = (title, inner) => `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${inner}</body></html>`;
  function noteHtml(n) {
    if (n.type === "rich") return sanitize(n.body);
    if (n.type === "markdown") return mdToHtml(n.body);
    if (n.type === "tasks") return "<ul>" + (n.tasks || []).map(t => `<li>${t.done ? "☑" : "☐"} ${esc(t.text)}</li>`).join("") + "</ul>";
    return (n.body || "").split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  }
  function downloadOptions() {
    const n = collect(), base = slug(n.title), title = n.title || "Untitled";
    const opts = [];
    if (n.type === "markdown") opts.push(["Markdown (.md)", base + ".md", n.body, "text/markdown"]);
    if (n.type === "tasks") opts.push(["Markdown checklist (.md)", base + ".md", (n.title ? "# " + n.title + "\n\n" : "") + (n.tasks || []).map(t => `- [${t.done ? "x" : " "}] ${t.text}`).join("\n"), "text/markdown"]);
    opts.push(["Text file (.txt)", base + ".txt", n.type === "plain" ? n.body : (n.title ? n.title + "\n\n" : "") + plainText(n), "text/plain"]);
    opts.push(["Word document (.doc)", base + ".doc", wrapWord(title, noteHtml(n)), "application/msword"]);
    opts.push(["Web page (.html)", base + ".html", wrapHtml(title, noteHtml(n)), "text/html"]);
    return opts;
  }
  function renderDownloadMenu() {
    const m = $("#menu-download");
    m.textContent = "";
    for (const [label, file, data, mime] of downloadOptions()) {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "menuitem");
      b.innerHTML = `<span class="m-title"></span><span class="m-sub"></span>`;
      $(".m-title", b).textContent = label; $(".m-sub", b).textContent = file;
      b.addEventListener("click", () => { closeMenus(); doDownload(file, data, mime); });
      m.append(b);
    }
    const pdf = document.createElement("button");
    pdf.type = "button"; pdf.setAttribute("role", "menuitem");
    pdf.innerHTML = `<span class="m-title">PDF (print)</span><span class="m-sub">Choose "Save as PDF" in the print dialog</span>`;
    pdf.addEventListener("click", () => { closeMenus(); printNote(); });
    m.append(pdf);
  }
  function doDownload(filename, data, mime) {
    if (!data || !String(data).trim()) { setStatus("This note is empty. Add something before downloading.", "warn"); return; }
    const url = URL.createObjectURL(new Blob([data], { type: (mime || "text/plain") + ";charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function printNote() {
    const n = collect();
    if (isEmpty(n)) { setStatus("This note is empty. Add something before printing.", "warn"); return; }
    const area = $("#print-area");
    area.textContent = "";
    const h = document.createElement("h1"); h.textContent = n.title || "Untitled";
    const body = document.createElement("div");
    renderReadOnly(n, body);
    area.append(h, body);
    window.print();
  }

  // ---------- import ----------
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });
  }
  async function importFile(f) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const title = f.name.replace(/\.[^.]+$/, "");
    if (f.size > 5 * 1024 * 1024) { setStatus("That file is over 5 MB. Pick a smaller file.", "warn"); return; }
    try {
      if (ext === "txt") return startNew("plain", { title, body: await f.text() });
      if (ext === "md" || ext === "markdown") return startNew("markdown", { title, body: await f.text() });
      if (ext === "html" || ext === "htm") {
        const doc = new DOMParser().parseFromString(await f.text(), "text/html");
        return startNew("rich", { title: doc.title || title, body: sanitize(doc.body.innerHTML) });
      }
      if (ext === "docx") {
        setStatus("Reading " + f.name + "…");
        if (!window.mammoth) await loadScript("https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js");
        const out = await window.mammoth.convertToHtml({ arrayBuffer: await f.arrayBuffer() });
        return startNew("rich", { title, body: sanitize(out.value) });
      }
      setStatus("Pick a .txt, .md, .html or .docx file.", "warn");
    } catch { setStatus("Couldn't read " + f.name + ". Try saving it as .txt or .docx and import again.", "warn"); }
  }

  // ---------- assistant ----------
  function resetChat() {
    if (S.chatCtl) S.chatCtl.abort();
    S.chat = [];
    renderChat();
  }
  function renderChat() {
    const log = $("#chat-log");
    log.textContent = "";
    const t = titleEl.value.trim();
    $("#chat-about").textContent = S.mode !== "cloud"
      ? "Sign in to use the assistant. It reads the note that's open and answers questions about it."
      : t ? `Asking about “${t}”. The assistant reads the note as it is right now.` : "The assistant reads the note that's open and answers questions about it.";
    $("#chat-chips").hidden = S.chat.length > 0;
    S.chat.forEach((m) => {
      const d = document.createElement("div");
      d.className = "msg " + m.role;
      d.textContent = m.role === "assistant" && m.pending ? "Thinking…" : m.content;
      if (m.note) { const s = document.createElement("span"); s.className = "m-note"; s.textContent = m.note; d.append(s); }
      if (m.role === "assistant" && !m.pending && m.content && !m.error) {
        const row = document.createElement("div"); row.className = "m-actions";
        const b = document.createElement("button"); b.type = "button"; b.className = "btn"; b.textContent = "Add to note";
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
      text.split("\n").map(l => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s*/, "").trim()).filter(Boolean)
        .forEach(l => S.tasks.push({ text: l, done: false }));
      renderTasks();
    } else {
      edPlain.value = edPlain.value.replace(/\s*$/, "") + (edPlain.value.trim() ? "\n\n" : "") + text;
      if (S.mdView === "preview") mdPreview.innerHTML = mdToHtml(edPlain.value);
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
        method: "POST",
        signal: ctl.signal,
        headers: { "Content-Type": "application/json", apikey: CFG.supabaseAnonKey, Authorization: `Bearer ${session ? session.access_token : ""}` },
        body: JSON.stringify({ note: { title: n.title, type: TYPES[n.type], text: plainText(n).slice(0, 12000) }, messages: turns }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.text) {
        reply.error = true;
        reply.note = AI_ERRORS[out.error] || "The assistant couldn't answer just now. Send your message again.";
      } else {
        reply.content = out.text;
        if (out.truncated) reply.note = "The answer was cut short. Ask for less at a time.";
      }
    } catch (e) {
      reply.error = true;
      reply.note = e && e.name === "AbortError" ? "Stopped." : "Couldn't reach the assistant. Check your connection and send again.";
    } finally {
      reply.pending = false;
      S.chatCtl = null;
      renderChat();
    }
  }
  function selectTab(which) {
    const chat = which === "chat";
    $("#tab-notes").setAttribute("aria-selected", String(!chat));
    $("#tab-chat").setAttribute("aria-selected", String(chat));
    $("#pane-notes").hidden = chat;
    $("#pane-chat").hidden = !chat;
  }

  // ---------- menus ----------
  function closeMenus() {
    $$(".menu").forEach(m => m.hidden = true);
    $$("[aria-haspopup='menu']").forEach(b => b.setAttribute("aria-expanded", "false"));
    $("#acct-menu").hidden = true;
    $("#btn-acct").setAttribute("aria-expanded", "false");
  }
  function toggleMenu(btn, menu) {
    const open = menu.hidden;
    closeMenus();
    if (open) { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); const f = menu.querySelector("button"); if (f) f.focus(); }
  }

  // ---------- wiring ----------
  titleEl.addEventListener("input", markDirty);
  edPlain.addEventListener("input", markDirty);
  edRich.addEventListener("input", markDirty);
  edRich.addEventListener("paste", (e) => {
    const html = e.clipboardData && e.clipboardData.getData("text/html");
    if (html) { e.preventDefault(); document.execCommand("insertHTML", false, sanitize(html)); }
  });
  edPlain.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); document.execCommand("insertText", false, "\t"); }
  });
  $$("#rich-tools button").forEach(b => {
    b.addEventListener("mousedown", e => e.preventDefault());
    b.addEventListener("click", () => { edRich.focus(); document.execCommand(b.dataset.cmd, false, b.dataset.arg ? `<${b.dataset.arg}>` : null); markDirty(); });
  });
  $$("#md-tabs button").forEach(b => b.addEventListener("click", () => { S.mdView = b.dataset.md; showEditorFor("markdown"); }));
  $("#task-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const inp = $("#task-input"), v = inp.value.trim();
    if (!v) return;
    S.tasks.push({ text: v, done: false }); inp.value = "";
    renderTasks(); markDirty();
  });

  $("#btn-save").addEventListener("click", () => save(true));
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(true); }
    if (e.key === "Escape") closeMenus();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap") && !e.target.closest(".acct")) closeMenus(); });

  $("#btn-new").addEventListener("click", () => toggleMenu($("#btn-new"), $("#menu-new")));
  $$("#menu-new button").forEach(b => b.addEventListener("click", () => { closeMenus(); startNew(b.dataset.type); }));
  $("#btn-download").addEventListener("click", () => { renderDownloadMenu(); toggleMenu($("#btn-download"), $("#menu-download")); });
  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); });
  $("#btn-share").addEventListener("click", openShare);
  $("#vis-btn").addEventListener("click", openShare);

  $("#search").addEventListener("input", (e) => { S.query = e.target.value; renderList(); });
  $$(".sortrow button").forEach(b => b.addEventListener("click", () => { S.sort = b.dataset.sort; ls.set("quillnote.sort", S.sort); renderList(); }));

  $("#tab-notes").addEventListener("click", () => selectTab("notes"));
  $("#tab-chat").addEventListener("click", () => { selectTab("chat"); renderChat(); });
  $("#btn-ai").addEventListener("click", () => {
    selectTab("chat"); renderChat();
    if (window.matchMedia("(max-width: 900px)").matches) $("#side").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#chat-input").focus();
  });
  $$("#chat-chips button").forEach(b => b.addEventListener("click", () => ask(b.textContent)));
  $("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#chat-input").value; $("#chat-input").value = ""; ask(v); });
  $("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); } });
  $("#chat-stop").addEventListener("click", () => { if (S.chatCtl) S.chatCtl.abort(); });

  $("#shared-close").addEventListener("click", closeShared);
  $("#shared-copy").addEventListener("click", () => {
    const n = S.shared; if (!n) return;
    closeShared();
    startNew(n.type || "plain", { title: n.title ? n.title + " (copy)" : "Shared note (copy)", body: n.body, tasks: n.tasks || [] });
  });

  $("#btn-signin").addEventListener("click", () => openAuth("signin"));
  $("#auth-close").addEventListener("click", closeAuth);
  $("#auth-form").addEventListener("submit", (e) => { e.preventDefault(); submitAuth(); });
  $$("#auth-tabs button").forEach(b => b.addEventListener("click", () => { const email = $("#auth-email").value; setAuthMode(b.dataset.mode); $("#auth-email").value = email; }));
  $("#auth-forgot").addEventListener("click", () => { const email = $("#auth-email").value; setAuthMode("forgot"); $("#auth-email").value = email; $("#auth-email").focus(); });
  $("#auth-back").addEventListener("click", () => { const email = $("#auth-email").value; setAuthMode("signin"); $("#auth-email").value = email; });
  $("#auth-show").addEventListener("change", (e) => { const t = e.target.checked ? "text" : "password"; $("#auth-password").type = t; $("#auth-confirm").type = t; });
  $("#btn-change-pw").addEventListener("click", () => { closeMenus(); openAuth("reset"); });
  $("#btn-google").addEventListener("click", () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirectTo() } }));
  $("#btn-acct").addEventListener("click", () => {
    const m = $("#acct-menu"), open = m.hidden;
    closeMenus();
    m.hidden = !open; $("#btn-acct").setAttribute("aria-expanded", String(open));
  });
  $("#btn-signout").addEventListener("click", async () => {
    closeMenus();
    if (S.dirty) await save(false);
    await sb.auth.signOut();
  });

  window.addEventListener("beforeunload", (e) => { if (S.dirty) { save(false); e.preventDefault(); e.returnValue = ""; } });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.mode === "cloud" && !S.dirty) refreshCloud();
  });

  // ---------- boot ----------
  openMostRecentOrExample();
  updateAccountUI(); renderList(); renderBanners();
  handleShareParam();

  if (sb) {
    sb.auth.onAuthStateChange((event, session) => {
      // Defer: supabase-js warns against awaiting other calls inside this callback.
      setTimeout(() => {
        if (event === "PASSWORD_RECOVERY") openAuth("reset");   // arrived from a reset-password email
        const user = session && session.user;
        if (user && (!S.user || S.user.id !== user.id)) enterCloud(user);
        else if (!user && S.mode === "cloud") leaveCloud();
      }, 0);
    });
  } else if (!CFG.supabaseUrl) {
    console.info(`${BRAND}: Supabase isn't configured (site/config.js), so the site runs in guest-only mode.`);
  }
})();
