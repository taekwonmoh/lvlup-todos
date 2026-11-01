import { mergeDocs, normalizeTodo, prettyJson, publicDoc, substance } from "./lib/merge.js";

(function () {
  var STORAGE_V3 = "moh-todos-v3";
  var STORAGE_V2 = "moh-todos-v2";
  var STORAGE_V1 = "lvlup-todos-v1";
  var PASS_KEY = "moh-todos-sync-pass";
  var DISMISS_KEY = "moh-todos-sync-dismiss";
  var STATUSES = ["not_started", "in_progress", "needs_input", "completed"];
  var STATUS_LABEL = {
    not_started: "Not started",
    in_progress: "In progress",
    needs_input: "Needs input",
    completed: "Completed"
  };

  var state = { todos: [], tombstones: {}, activeTab: "work", pendingSync: false, lastSyncOk: false, updatedAt: "" };
  var filter = "all";
  var editingId = null;
  var workerUrl = "";
  var passphrase = "";
  var formOpen = false;
  var syncing = false;
  var again = false;
  var timer = null;
  var retryMs = 2000;
  var lastFileCheck = 0;
  var lastConfigCheck = 0;
  var fileForce = true;
  var gen = 0;

  var listEl = document.getElementById("todoList");
  var openCountEl = document.getElementById("openCount");
  var addForm = document.getElementById("addForm");
  var newTodoInput = document.getElementById("newTodo");
  var clearBtn = document.getElementById("clearCompleted");
  var copyBtn = document.getElementById("copyJson");
  var syncLine = document.getElementById("syncLine");
  var syncForm = document.getElementById("syncForm");
  var syncPass = document.getElementById("syncPass");
  var syncDismiss = document.getElementById("syncDismiss");
  var syncSetup = document.getElementById("syncSetup");

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function isList(v) {
    return v === "work" || v === "personal";
  }

  function localDoc() {
    return {
      schemaVersion: 1,
      updatedAt: state.updatedAt || "",
      todos: state.todos,
      deleted: state.tombstones || {}
    };
  }

  function todosInTab() {
    return state.todos.filter(function (t) { return t.list === state.activeTab; });
  }

  function findIndex(id) {
    for (var i = 0; i < state.todos.length; i++) {
      if (state.todos[i].id === id) return i;
    }
    return -1;
  }

  function save() {
    localStorage.setItem(STORAGE_V3, JSON.stringify({
      todos: state.todos,
      tombstones: state.tombstones,
      activeTab: state.activeTab,
      pendingSync: state.pendingSync === true,
      lastSyncOk: state.lastSyncOk === true,
      updatedAt: state.updatedAt || ""
    }));
  }

  function readJson(key) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function migrateLegacy() {
    var v2 = readJson(STORAGE_V2);
    if (v2 && typeof v2 === "object") {
      var out = [];
      ["work", "personal"].forEach(function (list) {
        var arr = Array.isArray(v2[list]) ? v2[list] : [];
        arr.forEach(function (item) {
          var n = normalizeTodo(item, list);
          if (n) {
            n.updatedAt = nowIso();
            out.push(n);
          }
        });
      });
      return {
        todos: out,
        tombstones: {},
        activeTab: isList(v2.activeTab) ? v2.activeTab : "work"
      };
    }
    var v1 = readJson(STORAGE_V1);
    if (Array.isArray(v1)) {
      return {
        todos: v1.map(function (item) {
          var n = normalizeTodo(item, "work");
          if (n) n.updatedAt = nowIso();
          return n;
        }).filter(Boolean),
        tombstones: {},
        activeTab: "work"
      };
    }
    return null;
  }

  function loadLocal() {
    passphrase = localStorage.getItem(PASS_KEY) || "";
    var v3 = readJson(STORAGE_V3);
    if (v3 && Array.isArray(v3.todos)) {
      state.todos = v3.todos.map(function (item) { return normalizeTodo(item, "work"); }).filter(Boolean);
      state.tombstones = v3.tombstones && typeof v3.tombstones === "object" ? v3.tombstones : {};
      state.activeTab = isList(v3.activeTab) ? v3.activeTab : "work";
      state.pendingSync = v3.pendingSync === true;
      state.lastSyncOk = v3.lastSyncOk === true;
      state.updatedAt = typeof v3.updatedAt === "string" ? v3.updatedAt : "";
      return;
    }
    var legacy = migrateLegacy();
    if (legacy) {
      state.todos = legacy.todos;
      state.tombstones = legacy.tombstones;
      state.activeTab = legacy.activeTab;
      state.pendingSync = true;
      state.lastSyncOk = false;
      save();
      return;
    }
    state.todos = [];
    state.tombstones = {};
    state.activeTab = "work";
  }

  function markPending() {
    state.pendingSync = true;
    gen += 1;
    save();
    schedule(350);
  }

  function applyDoc(doc) {
    var nextTodos = doc.todos || [];
    var nextDeleted = doc.deleted || {};
    if (editingId) {
      var localEdit = null;
      for (var i = 0; i < state.todos.length; i++) {
        if (state.todos[i].id === editingId) localEdit = state.todos[i];
      }
      if (localEdit) {
        var copy = nextTodos.slice();
        var idx = -1;
        for (var j = 0; j < copy.length; j++) {
          if (copy[j].id === editingId) idx = j;
        }
        if (idx === -1) copy.unshift(localEdit);
        else copy[idx] = localEdit;
        nextTodos = copy;
        if (nextDeleted[editingId]) {
          nextDeleted = Object.assign({}, nextDeleted);
          delete nextDeleted[editingId];
        }
      }
    }
    var before = substance(localDoc());
    state.todos = nextTodos;
    state.tombstones = nextDeleted;
    state.updatedAt = doc.updatedAt || state.updatedAt || "";
    save();
    var after = substance(localDoc());
    if (before !== after && !editingId) {
      var y = window.scrollY;
      render();
      window.scrollTo(0, y);
    }
  }

  function setSync(msg) { syncLine.textContent = msg; }

  function dismissed() {
    try { return sessionStorage.getItem(DISMISS_KEY) === "1"; }
    catch (e) { return false; }
  }

  function updateGate() {
    var show = formOpen || (!!workerUrl && !passphrase && !dismissed());
    syncForm.hidden = !show;
  }

  function loadConfig(force) {
    var staleAfter = workerUrl ? 60000 : 30000;
    if (!force && Date.now() - lastConfigCheck < staleAfter) return Promise.resolve();
    lastConfigCheck = Date.now();
    return fetch("./sync-config.json?t=" + Date.now(), { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("status " + res.status);
      return res.json();
    }).then(function (cfg) {
      workerUrl = String(cfg && cfg.workerUrl || "").trim().replace(/\/$/, "");
      updateGate();
    }).catch(function () {});
  }

  function mergeSharedFile() {
    lastFileCheck = Date.now();
    fileForce = false;
    return fetch("./todos.json?t=" + Date.now(), { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("status " + res.status);
      return res.json();
    }).then(function (doc) {
      var before = substance(localDoc());
      var merged = mergeDocs(localDoc(), doc, { matchText: true });
      if (substance(merged) !== before) {
        applyDoc(merged);
        if (workerUrl && passphrase) markPending();
        if (!workerUrl) setSync("Merged shared list");
      } else if (!workerUrl) {
        setSync("Shared list is up to date");
      }
    }).catch(function () {
      if (!workerUrl) {
        setSync(state.todos.length ? "Offline — showing this device" : "Could not load shared list");
      }
    });
  }

  function permanentError(message) {
    var err = new Error(message);
    err.permanent = true;
    return err;
  }

  function request(method, path, payload) {
    var headers = { Authorization: "Bearer " + passphrase };
    if (payload) headers["Content-Type"] = "application/json";
    return fetch(workerUrl + path, {
      method: method,
      cache: "no-store",
      headers: headers,
      body: payload ? JSON.stringify(payload) : undefined
    }).then(function (res) {
      if (res.status === 401) {
        passphrase = "";
        localStorage.removeItem(PASS_KEY);
        formOpen = true;
        try { sessionStorage.removeItem(DISMISS_KEY); } catch (e) {}
        updateGate();
        setSync("That passphrase was not accepted");
        throw permanentError("unauthorized");
      }
      if (res.status === 429) {
        setSync("Too many tries. Wait a few minutes, then enter the passphrase again.");
        throw permanentError("rate");
      }
      if (res.status === 503) {
        setSync("Sync isn't finished being set up yet");
        throw permanentError("unconfigured");
      }
      if (!res.ok) throw new Error("status " + res.status);
      return res.json();
    });
  }

  function push() {
    setSync("Syncing…");
    var sent = gen;
    return request("POST", "/v1/list", publicDoc(localDoc())).then(function (remote) {
      var merged = mergeDocs(localDoc(), remote);
      applyDoc(merged);
      state.lastSyncOk = true;
      if (gen === sent && substance(localDoc()) === substance(remote)) {
        state.pendingSync = false;
        setSync("Synced");
      } else {
        state.pendingSync = true;
        setSync("Syncing…");
      }
      save();
    });
  }

  function pull() {
    return request("GET", "/v1/list").then(function (remote) {
      var merged = mergeDocs(localDoc(), remote);
      applyDoc(merged);
      state.lastSyncOk = true;
      if (substance(localDoc()) !== substance(remote)) {
        state.pendingSync = true;
        setSync("Syncing…");
      } else {
        state.pendingSync = false;
        setSync("Synced");
      }
      save();
    });
  }

  function runSync() {
    return loadConfig(false).then(function () {
      updateGate();
      var fileDue = fileForce || Date.now() - lastFileCheck > 60000;
      var fileTask = fileDue ? mergeSharedFile() : Promise.resolve();
      return fileTask.then(function () {
        if (!workerUrl) return;
        if (!passphrase) {
          setSync("Enter the sync passphrase to sync this device");
          return;
        }
        if (state.pendingSync || !state.lastSyncOk) return push();
        return pull();
      });
    });
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
  }

  function tick() {
    if (syncing) {
      again = true;
      return;
    }
    syncing = true;
    runSync().then(function () {
      retryMs = 2000;
    }).catch(function (e) {
      if (!(e && e.permanent)) {
        retryMs = Math.min(retryMs * 2, 30000);
        if (state.pendingSync) setSync("Offline — changes saved here and will sync when you reconnect");
        else if (workerUrl) setSync("Couldn't reach sync — changes saved on this device");
      } else {
        retryMs = 30000;
      }
    }).then(function () {
      syncing = false;
      if (again) {
        again = false;
        schedule(200);
        return;
      }
      var visible = document.visibilityState === "visible";
      var wait = visible ? 5000 : 30000;
      if (state.pendingSync && workerUrl && passphrase) wait = Math.min(retryMs, wait);
      schedule(wait);
    });
  }

  function openCount() {
    return todosInTab().filter(function (t) { return t.status !== "completed"; }).length;
  }

  function visibleTodos() {
    var all = todosInTab();
    if (STATUSES.indexOf(filter) !== -1) {
      return all.filter(function (t) { return t.status === filter; });
    }
    return all.slice();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusOptions(current) {
    return STATUSES.map(function (s) {
      return '<option value="' + s + '"' + (s === current ? " selected" : "") + ">" + STATUS_LABEL[s] + "</option>";
    }).join("");
  }

  function checkMark(status) {
    if (status === "completed") {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    }
    if (status === "in_progress") {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="6" y1="12" x2="18" y2="12"></line></svg>';
    }
    if (status === "needs_input") {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M9 9a3 3 0 1 1 4 2.8c-.8.4-1 1-1 2"></path><line x1="12" y1="18" x2="12" y2="18.01"></line></svg>';
    }
    return '<svg viewBox="0 0 24 24"></svg>';
  }

  function updateTabUI() {
    document.querySelectorAll(".tab-btn").forEach(function (btn) {
      var on = btn.getAttribute("data-tab") === state.activeTab;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    var label = state.activeTab === "work" ? "Work" : "Personal";
    newTodoInput.placeholder = "Add to " + label + "…";
  }

  function setTab(tab) {
    if (!isList(tab) || state.activeTab === tab) return;
    editingId = null;
    state.activeTab = tab;
    save();
    updateTabUI();
    render();
  }

  function render() {
    openCountEl.textContent = String(openCount());
    var items = visibleTodos();
    var tabLabel = state.activeTab === "work" ? "Work" : "Personal";

    if (items.length === 0) {
      var msg = filter === "all"
        ? (tabLabel === "Personal" ? "No personal tasks yet. Add one below." : "No work tasks yet. Add one below.")
        : "Nothing " + STATUS_LABEL[filter].toLowerCase() + " in " + tabLabel + ".";
      listEl.innerHTML = '<li class="empty">' + msg + "</li>";
      return;
    }

    listEl.innerHTML = items.map(function (t) {
      var isEditing = editingId === t.id;
      var body = isEditing
        ? '<input class="todo-edit" data-id="' + escapeHtml(t.id) + '" value="' + escapeHtml(t.text) + '" aria-label="Edit task" />' +
          '<textarea class="todo-notes-edit" data-id="' + escapeHtml(t.id) + '" aria-label="Notes" placeholder="Notes (optional)">' + escapeHtml(t.notes || "") + "</textarea>"
        : '<div class="todo-text" data-id="' + escapeHtml(t.id) + '" tabindex="0" role="button" title="Tap to edit">' + escapeHtml(t.text) + "</div>" +
          (t.notes ? '<div class="todo-notes">' + escapeHtml(t.notes) + "</div>" : "");

      var checkLabel = t.status === "completed" ? "Mark not started" : "Mark completed";
      return (
        '<li class="todo ' + t.status + '" data-id="' + escapeHtml(t.id) + '">' +
          '<button type="button" class="check" data-action="toggle" data-id="' + escapeHtml(t.id) + '" aria-label="' + checkLabel + '">' +
            checkMark(t.status) +
          "</button>" +
          '<div class="todo-body">' + body + "</div>" +
          '<div class="todo-side">' +
            '<select class="status-select" data-action="status" data-id="' + escapeHtml(t.id) + '" aria-label="Status">' +
              statusOptions(t.status) +
            "</select>" +
            '<div class="actions">' +
              '<button type="button" class="icon-btn" data-action="edit" data-id="' + escapeHtml(t.id) + '" aria-label="Edit" title="Edit">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>' +
              "</button>" +
              '<button type="button" class="icon-btn delete" data-action="delete" data-id="' + escapeHtml(t.id) + '" aria-label="Delete" title="Delete">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
              "</button>" +
            "</div>" +
          "</div>" +
        "</li>"
      );
    }).join("");

    if (editingId) {
      var editInput = listEl.querySelector(".todo-edit");
      if (editInput) {
        editInput.focus();
        editInput.setSelectionRange(editInput.value.length, editInput.value.length);
      }
    }
  }

  function addTodo(text) {
    var trimmed = text.trim();
    if (!trimmed) return;
    state.todos.unshift({
      id: uid(),
      text: trimmed,
      list: state.activeTab,
      status: "not_started",
      updatedAt: nowIso(),
      notes: ""
    });
    markPending();
    render();
  }

  function setStatus(id, status) {
    if (STATUSES.indexOf(status) === -1) return;
    var t = state.todos[findIndex(id)];
    if (!t || t.status === status) return;
    t.status = status;
    t.updatedAt = nowIso();
    markPending();
    render();
  }

  function toggleTodo(id) {
    var t = state.todos[findIndex(id)];
    if (!t) return;
    t.status = t.status === "completed" ? "not_started" : "completed";
    t.updatedAt = nowIso();
    markPending();
    render();
  }

  function deleteTodo(id) {
    var idx = findIndex(id);
    if (idx === -1) return;
    state.tombstones[id] = nowIso();
    state.todos.splice(idx, 1);
    if (editingId === id) editingId = null;
    markPending();
    render();
  }

  function startEdit(id) {
    editingId = id;
    render();
  }

  function commitEdit(id, text, notes) {
    var t = state.todos[findIndex(id)];
    editingId = null;
    if (!t) { render(); return; }
    var trimmed = String(text || "").trim();
    if (!trimmed) {
      deleteTodo(id);
      return;
    }
    var nextNotes = String(notes || "");
    if (t.text !== trimmed || (t.notes || "") !== nextNotes) {
      t.text = trimmed;
      t.notes = nextNotes;
      t.updatedAt = nowIso();
      markPending();
    }
    render();
  }

  function clearCompleted() {
    var before = state.todos.length;
    var stamp = nowIso();
    state.todos = state.todos.filter(function (t) {
      if (t.list === state.activeTab && t.status === "completed") {
        state.tombstones[t.id] = stamp;
        return false;
      }
      return true;
    });
    if (state.todos.length === before) return;
    markPending();
    render();
  }

  function copyJson() {
    var text = prettyJson(localDoc());
    function done(ok) {
      copyBtn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(function () { copyBtn.textContent = "Copy JSON"; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }).catch(function () { done(false); });
      return;
    }
    done(false);
  }

  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    addTodo(newTodoInput.value);
    newTodoInput.value = "";
    newTodoInput.blur();
  });

  clearBtn.addEventListener("click", clearCompleted);
  copyBtn.addEventListener("click", copyJson);

  syncForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var value = syncPass.value.trim();
    if (!value) return;
    passphrase = value;
    localStorage.setItem(PASS_KEY, value);
    syncPass.value = "";
    formOpen = false;
    try { sessionStorage.removeItem(DISMISS_KEY); } catch (err) {}
    state.lastSyncOk = false;
    save();
    updateGate();
    setSync(workerUrl ? "Syncing…" : "Passphrase saved on this device");
    schedule(100);
  });

  syncDismiss.addEventListener("click", function () {
    formOpen = false;
    try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch (e) {}
    updateGate();
    if (!passphrase) setSync(workerUrl ? "On this device until you enter the passphrase" : "On this device only");
  });

  syncSetup.addEventListener("click", function () {
    formOpen = true;
    updateGate();
    syncPass.focus();
  });

  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { setTab(btn.getAttribute("data-tab")); });
  });

  document.querySelectorAll(".filter-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      filter = btn.getAttribute("data-filter");
      document.querySelectorAll(".filter-btn").forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      render();
    });
  });

  listEl.addEventListener("change", function (e) {
    if (e.target.classList.contains("status-select")) {
      setStatus(e.target.getAttribute("data-id"), e.target.value);
    }
  });

  listEl.addEventListener("click", function (e) {
    var actionEl = e.target.closest("[data-action]");
    if (actionEl && actionEl.classList.contains("status-select")) return;
    if (actionEl) {
      var action = actionEl.getAttribute("data-action");
      var id = actionEl.getAttribute("data-id");
      if (action === "toggle") toggleTodo(id);
      else if (action === "delete") deleteTodo(id);
      else if (action === "edit") startEdit(id);
      return;
    }
    var textEl = e.target.closest(".todo-text");
    if (textEl) startEdit(textEl.getAttribute("data-id"));
  });

  listEl.addEventListener("keydown", function (e) {
    if (e.target.classList.contains("todo-text") && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      startEdit(e.target.getAttribute("data-id"));
    }
    if (e.target.classList.contains("todo-edit") && e.key === "Enter") {
      e.preventDefault();
      var li = e.target.closest(".todo");
      var notesEl = li.querySelector(".todo-notes-edit");
      commitEdit(e.target.getAttribute("data-id"), e.target.value, notesEl ? notesEl.value : "");
    } else if ((e.target.classList.contains("todo-edit") || e.target.classList.contains("todo-notes-edit")) && e.key === "Escape") {
      editingId = null;
      render();
    }
  });

  listEl.addEventListener("focusout", function (e) {
    if (!e.target.classList.contains("todo-edit") && !e.target.classList.contains("todo-notes-edit")) return;
    var li = e.target.closest(".todo");
    var id = e.target.getAttribute("data-id");
    var textEl = li.querySelector(".todo-edit");
    var notesEl = li.querySelector(".todo-notes-edit");
    var text = textEl ? textEl.value : "";
    var notes = notesEl ? notesEl.value : "";
    setTimeout(function () {
      if (editingId === id && !li.contains(document.activeElement)) commitEdit(id, text, notes);
    }, 0);
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      fileForce = true;
      schedule(100);
    }
  });
  window.addEventListener("online", function () { schedule(100); });
  window.addEventListener("focus", function () {
    fileForce = true;
    schedule(100);
  });

  loadLocal();
  updateTabUI();
  render();
  updateGate();
  schedule(50);

  if ("serviceWorker" in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (hadController) window.location.reload();
    });
    var register = function () {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register);
  }
})();
