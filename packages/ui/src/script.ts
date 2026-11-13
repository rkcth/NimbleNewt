/**
 * The web chat's script (card U07), served as /app.js. No build step and no dependency: the file below is plain browser JavaScript kept in a string.
 * It has two parts. The core (`NNCore`) does the network work and holds no DOM: the outbox that keeps every sent message until the controller has answered it, and the client that
 * sends the outbox in order and again after a dropped connection with the SAME message id (the controller records a turn under that id, so the second send returns the first turn and
 * runs nothing twice). The glue after it draws the page and runs only where there is a `document`. It writes text with textContent only, never markup.
 */
export const APP_JS = String.raw`(function (root) {
  'use strict';

  var OUTBOX_KEY = 'nn.outbox.v1';
  var KEEP = 100;

  function safeStorage(storage) {
    return {
      get: function (k) { try { return storage ? storage.getItem(k) : null; } catch (e) { return null; } },
      set: function (k, v) { try { if (storage) storage.setItem(k, v); } catch (e) { /* private mode or full: the page still works, it just cannot resume after a reload */ } },
      remove: function (k) { try { if (storage) storage.removeItem(k); } catch (e) { /* ignore */ } }
    };
  }

  /** The messages and decisions the owner made on this phone, oldest first. An item stays until the controller answered it. */
  function createOutbox(rawStorage) {
    var store = safeStorage(rawStorage);
    var items = [];
    try { var saved = JSON.parse(store.get(OUTBOX_KEY) || '[]'); if (Array.isArray(saved)) items = saved.filter(function (i) { return i && typeof i.id === 'string' && typeof i.kind === 'string'; }); } catch (e) { items = []; }
    // A page that was closed while a send was in flight did not hear the answer: it sends again, with the same id.
    items.forEach(function (i) { if (i.state === 'sending') i.state = 'pending'; });
    function save() {
      var done = items.filter(function (i) { return i.state === 'done' || i.state === 'failed'; });
      if (done.length > KEEP) { var drop = done.slice(0, done.length - KEEP); items = items.filter(function (i) { return drop.indexOf(i) < 0; }); }
      store.set(OUTBOX_KEY, JSON.stringify(items));
    }
    return {
      items: function () { return items.slice(); },
      add: function (item) { items.push(item); save(); return item; },
      update: function (item, patch) { for (var k in patch) item[k] = patch[k]; save(); },
      pending: function () { return items.filter(function (i) { return i.state === 'pending' || i.state === 'sending'; }); },
      clear: function () { items = []; store.remove(OUTBOX_KEY); },
      discard: function (item) { items = items.filter(function (i) { return i !== item; }); save(); }
    };
  }

  function randomId(cryptoApi) {
    var bytes = new Uint8Array(12);
    if (cryptoApi && cryptoApi.getRandomValues) cryptoApi.getRandomValues(bytes); else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var out = 'm';
    for (var j = 0; j < bytes.length; j++) out += (bytes[j] + 256).toString(16).slice(1);
    return out;
  }

  /**
   * The conversation with the controller. Everything that must happen exactly once is an outbox item with its own id, and the id is what makes a repeat harmless: a message is recorded
   * by the controller under its id, a decision on a proposal under its Idempotency-Key.
   */
  function createClient(deps) {
    var fetchFn = deps.fetch;
    var outbox = deps.outbox;
    var csrf = null;
    var flushing = null;
    var timer = null;
    var delay = 0;
    var state = { signedIn: false, owner: null, online: true };
    var listeners = [];
    function emit() { listeners.forEach(function (l) { try { l(); } catch (e) { /* a listener must not stop the client */ } }); }

    function call(method, path, body, extra) {
      var headers = { 'accept': 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (method !== 'GET' && csrf) headers['x-nn-csrf'] = csrf;
      if (extra) for (var k in extra) headers[k] = extra[k];
      return fetchFn(path, { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) }).then(function (res) {
        return res.text().then(function (text) {
          var json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
          return { status: res.status, body: json };
        });
      });
    }

    function adopt(r) {
      if (r.status === 200 && r.body && r.body.authenticated) { csrf = r.body.csrf; state.signedIn = true; state.owner = r.body.owner; state.expiresAt = r.body.expiresAt; }
      else { csrf = null; state.signedIn = false; }
      emit();
      return r;
    }

    function schedule() {
      if (timer || outbox.pending().length === 0 || !state.signedIn) return;
      delay = Math.min(delay === 0 ? 1000 : delay * 2, 30000);
      timer = (deps.setTimeout || setTimeout)(function () { timer = null; client.flush(); }, delay);
    }

    function describeError(r) { return (r.body && r.body.error && r.body.error.message) || ('the request failed (' + r.status + ')'); }

    function sendItem(item) {
      if (item.kind === 'message') return call('POST', '/web/chat', { messageId: item.id, text: item.text });
      if (item.kind === 'thinking') return call('POST', '/web/thinking/collection', { enabled: item.enabled === true }, { 'idempotency-key': item.id });
      if (item.kind === 'approval') return call('POST', '/web/approvals/' + encodeURIComponent(item.proposalId) + '/' + item.action, item.days === undefined ? {} : { days: item.days }, { 'idempotency-key': item.id });
      return call('POST', '/web/proposals/' + encodeURIComponent(item.proposalId) + '/' + item.decision, {}, { 'idempotency-key': item.id });
    }

    var client = {
      state: state,
      onChange: function (l) { listeners.push(l); },
      outbox: outbox,
      session: function () { return call('GET', '/web/session').then(adopt).catch(function () { state.online = false; emit(); return { status: 0 }; }); },
      login: function (credential) {
        var body = credential.code ? { code: credential.code } : { token: credential.token };
        return call('POST', '/web/login', body).then(adopt).then(function (r) { if (r.status === 200) client.flush(); return r; });
      },
      logout: function () { return call('POST', '/web/logout', {}).then(function (r) { csrf = null; state.signedIn = false; outbox.clear(); emit(); return r; }).catch(function () { csrf = null; state.signedIn = false; emit(); }); },
      say: function (text) {
        var item = outbox.add({ id: (deps.newId || function () { return randomId(root.crypto); })(), kind: 'message', text: text, at: (deps.now || Date.now)(), state: 'pending' });
        emit();
        client.flush();
        return item;
      },
      decide: function (proposalId, decision) {
        var item = outbox.add({ id: (deps.newId || function () { return randomId(root.crypto); })(), kind: 'proposal', proposalId: proposalId, decision: decision, at: (deps.now || Date.now)(), state: 'pending' });
        emit();
        client.flush();
        return item;
      },
      /**
       * A button on the approvals page (card U08b): Accept (with a length) or Dismiss of a standing-rule proposal. It is one outbox item with its own id, sent under that id as the Idempotency-Key, and the
       * controller runs it as the chat turn for the same words: Accept comes back as a proposal to confirm, Dismiss is done. 'label' is only what the page shows until the answer comes.
       */
      approval: function (proposalId, action, days, label) {
        var item = outbox.add({ id: (deps.newId || function () { return randomId(root.crypto); })(), kind: 'approval', proposalId: proposalId, action: action, days: days, text: label, at: (deps.now || Date.now)(), state: 'pending' });
        emit();
        client.flush();
        return item;
      },
      /** The switch for collecting the model's thinking (card U09b): one outbox item, sent under its id as the Idempotency-Key, run as the chat turn for the same words, which applies it at once. */
      thinking: function (enabled, label) {
        var item = outbox.add({ id: (deps.newId || function () { return randomId(root.crypto); })(), kind: 'thinking', enabled: enabled === true, text: label, at: (deps.now || Date.now)(), state: 'pending' });
        emit();
        client.flush();
        return item;
      },
      /** Sends what is waiting, one at a time and in order. It stops at the first item that cannot be answered now and tries again later. */
      flush: function () {
        if (flushing) return flushing;
        flushing = (function next() {
          var item = outbox.pending()[0];
          if (!item || !state.signedIn) return Promise.resolve();
          outbox.update(item, { state: 'sending' });
          emit();
          return sendItem(item).then(function (r) {
            if (r.status === 200 || r.status === 201) { delay = 0; state.online = true; outbox.update(item, { state: 'done', result: r.body }); emit(); return next(); }
            if (r.status === 401) { outbox.update(item, { state: 'pending' }); csrf = null; state.signedIn = false; emit(); return undefined; }
            if (r.status === 403 && r.body && r.body.error && r.body.error.code === 'csrf') { outbox.update(item, { state: 'pending' }); return client.session().then(function (s) { return s.status === 200 ? next() : undefined; }); }
            if (r.status === 429 || r.status >= 500) { outbox.update(item, { state: 'pending' }); schedule(); emit(); return undefined; }
            outbox.update(item, { state: 'failed', error: describeError(r) });
            emit();
            return next();
          }, function () {
            // The connection dropped (a phone asleep, a tunnel gone): keep the item, with its id, and send it again later.
            outbox.update(item, { state: 'pending' });
            state.online = false;
            schedule();
            emit();
          });
        })().then(function () { flushing = null; }, function () { flushing = null; });
        return flushing;
      },
      view: function (name) { return call('GET', '/web/views/' + encodeURIComponent(name)); },
      /** The replay of one task (card U09b): reads, plus the owner's recorded look at thinking and the simulation, each under its own Idempotency-Key so a retry runs once. */
      replay: function (taskId, filters) { var q = Object.keys(filters || {}).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(filters[k]); }).join('&'); return call('GET', '/web/replay/' + encodeURIComponent(taskId) + (q ? '?' + q : '')); },
      replayStep: function (taskId, seq) { return call('GET', '/web/replay/' + encodeURIComponent(taskId) + '/steps/' + encodeURIComponent(String(seq))); },
      replaySearch: function (taskId, q) { return call('GET', '/web/replay/' + encodeURIComponent(taskId) + '/search?q=' + encodeURIComponent(q)); },
      replayThinking: function (taskId) { return call('POST', '/web/replay/' + encodeURIComponent(taskId) + '/thinking', {}, { 'idempotency-key': (deps.newId || function () { return randomId(root.crypto); })() }); },
      replaySimulate: function (taskId, body) { return call('POST', '/web/replay/' + encodeURIComponent(taskId) + '/simulate', body || {}, { 'idempotency-key': (deps.newId || function () { return randomId(root.crypto); })() }); },
      sessions: function () { return call('GET', '/web/sessions'); },
      settings: function () { return call('GET', '/web/settings'); },
      revoke: function (arg) { return call('POST', '/web/sessions/revoke', arg); },
      pair: function () { return call('POST', '/web/pairings', {}); },
      /** After the page comes back to the front or the network returns. */
      resume: function () { state.online = true; delay = 0; if (timer) { (deps.clearTimeout || clearTimeout)(timer); timer = null; } return client.session().then(function (r) { if (r.status === 200) return client.flush(); }); }
    };
    return client;
  }

  /** Plain lines for a status result: the lines the controller wrote, or the fields of the record. Never markup. */
  function linesOf(value, depth) {
    depth = depth || 0;
    if (value === null || value === undefined) return [];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    if (Array.isArray(value)) return value.slice(0, 50).reduce(function (a, v) { return a.concat(linesOf(v, depth + 1)); }, []);
    if (typeof value === 'object') {
      if (typeof value.text === 'string') return [value.text];
      if (typeof value.summary === 'string' && typeof value.title === 'string') return [value.title + ': ' + value.summary];
      if (Array.isArray(value.lines) && depth < 6) return value.lines.slice(0, 60).map(function (l) { return typeof l === 'string' ? l : (l && l.text) || ''; }).filter(Boolean);
      if (depth > 3) return [];
      var out = [];
      Object.keys(value).slice(0, 40).forEach(function (k) {
        var v = value[k];
        if (v !== null && typeof v === 'object') { var sub = linesOf(v, depth + 1); if (sub.length) { out.push(k + ':'); sub.forEach(function (s) { out.push('  ' + s); }); } }
        else if (v !== undefined && v !== null) out.push(k + ': ' + v);
      });
      return out;
    }
    return [];
  }

  root.NNCore = { createOutbox: createOutbox, createClient: createClient, linesOf: linesOf, randomId: randomId };
  if (typeof root.document === 'undefined') return;

  // ---- the page ------------------------------------------------------------------------------------------------------------
  var doc = root.document;
  var $ = function (id) { return doc.getElementById(id); };
  var client = createClient({ fetch: root.fetch.bind(root), outbox: createOutbox(root.localStorage) });
  var tab = 'chat';
  var VIEW_TABS = { status: 'Status', 'needs-you': 'Needs you', approvals: 'Approvals', models: 'Models', blockers: 'Blockers', cost: 'Cost', recovery: 'Recovery', replay: 'Replay', setup: 'Setup' };

  function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function renderGate() {
    var gate = $('gate'), app = $('app');
    gate.hidden = client.state.signedIn;
    app.hidden = !client.state.signedIn;
    $('who').textContent = client.state.owner ? client.state.owner : '';
    var net = $('net');
    var waiting = client.outbox.pending().length;
    net.textContent = !client.state.online ? 'Offline' + (waiting ? ' - ' + waiting + ' waiting to send' : '') : waiting ? waiting + ' sending' : 'Connected';
    net.className = 'pill ' + (client.state.online ? 'ok' : 'warn');
  }

  function renderChat() {
    var list = $('log');
    var stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    clear(list);
    client.outbox.items().forEach(function (item) {
      if (item.kind === 'message' || item.kind === 'approval' || item.kind === 'thinking') {
        list.appendChild(el('div', 'msg me', item.kind !== 'message' && item.result && typeof item.result.text === 'string' ? item.result.text : item.text));
        var meta = el('div', 'meta', item.state === 'done' ? '' : item.state === 'failed' ? 'Not sent: ' + (item.error || 'refused') : item.state === 'sending' ? 'Sending...' : 'Waiting to send');
        if (meta.textContent) list.appendChild(meta);
        if (item.state === 'done' && item.result) {
          (item.result.reply || []).forEach(function (line) { list.appendChild(el('div', 'msg bot', line)); });
          (item.result.outcomes || []).forEach(function (o) {
            if (o.status === 'proposed' && o.proposalId) renderProposal(list, o);
            else if (o.status === 'asked' && o.options && o.options.length) { var row = el('div', 'chips'); o.options.slice(0, 6).forEach(function (opt) { var b = el('button', 'chip', opt); b.type = 'button'; b.addEventListener('click', function () { client.say(opt); }); row.appendChild(b); }); list.appendChild(row); }
          });
        }
      } else {
        var verb = item.decision === 'apply' ? 'Apply' : 'Discard';
        var line = el('div', 'meta', verb + ' proposal: ' + (item.state === 'done' ? (item.result && item.result.failure ? 'failed - ' + item.result.failure.message : item.result && item.result.applied === false ? 'not applied' : 'done') : item.state === 'failed' ? 'refused - ' + item.error : 'waiting to send'));
        list.appendChild(line);
      }
    });
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function decided(proposalId) { return client.outbox.items().some(function (i) { return i.kind === 'proposal' && i.proposalId === proposalId && i.state !== 'failed'; }); }
  function renderProposal(list, o) {
    var card = el('div', 'card');
    card.appendChild(el('div', 'card-title', 'Proposal - nothing has changed yet'));
    (o.preview || []).forEach(function (p) { card.appendChild(el('div', 'card-line', p)); });
    if (decided(o.proposalId)) card.appendChild(el('div', 'meta', 'Decision sent'));
    else {
      var row = el('div', 'row');
      var apply = el('button', 'btn primary', 'Apply'); apply.type = 'button';
      var drop = el('button', 'btn', 'Discard'); drop.type = 'button';
      apply.addEventListener('click', function () { client.decide(o.proposalId, 'apply'); });
      drop.addEventListener('click', function () { client.decide(o.proposalId, 'discard'); });
      row.appendChild(apply); row.appendChild(drop); card.appendChild(row);
    }
    list.appendChild(card);
  }


  // ---- the settings pages (card U08b): read only, drawn field by field --------------------------------------------------------------
  // Every field is named here, so a field the controller adds later (a key, a credential name) is not drawn by accident, and every value is text: the strings in these records come from agents
  // and from the owner's own settings, and are never markup. A secret is not on any of these records and has no field here: secrets are written in the secret store on the machine, never read back.
  var uid = 0;
  // Control characters, bidirectional overrides and isolates and zero-width characters are shown as their code (review): an unclosed right-to-left override in an agent's text would
  // otherwise turn the rest of a line around ("... for <agent> in project <id>"), so the owner would read something other than what the record says.
  var UNSEEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
  function unseen(c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); }
  function clip(v, n) { var t = v === null || v === undefined ? '' : String(v); t = t.length > n ? t.slice(0, n - 3) + '...' : t; return t.replace(UNSEEN, unseen); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function obj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null; }
  function list(v, max) { return Array.isArray(v) ? v.slice(0, max || 200) : []; }
  /** A titled region: a section named by its heading, so a screen reader can jump between them. */
  function region(box, title) {
    var sec = el('section', 'card');
    var h = el('h3', 'card-title', title); h.id = 'nn-h' + (++uid);
    sec.setAttribute('aria-labelledby', h.id);
    sec.appendChild(h);
    box.appendChild(sec);
    return sec;
  }
  function note(parent, text) { parent.appendChild(el('p', 'meta', text)); }
  /** A table with a caption, column headers and the first cell of each row as its row header. */
  function table(parent, caption, heads, rows) {
    var wrap = el('div', 'tablewrap');
    var t = el('table', 'grid');
    t.appendChild(el('caption', 'sr', caption));
    var tr = el('tr');
    heads.forEach(function (h) { var th = el('th', null, h); th.setAttribute('scope', 'col'); tr.appendChild(th); });
    var head = el('thead'); head.appendChild(tr); t.appendChild(head);
    var body = el('tbody');
    rows.forEach(function (row) {
      var r = el('tr');
      row.forEach(function (cell, i) { var c = el(i === 0 ? 'th' : 'td', null, clip(cell, 300)); if (i === 0) c.setAttribute('scope', 'row'); r.appendChild(c); });
      body.appendChild(r);
    });
    t.appendChild(body); wrap.appendChild(t); parent.appendChild(wrap);
  }
  /** What a part says when its read failed: the controller's own plain words, as text. */
  function failed(box, title, part) {
    var e = part && obj(part.error);
    if (!e) return false;
    var sec = region(box, title);
    sec.appendChild(el('p', 'error', 'Could not load: ' + clip(e.message || e.code, 300)));
    return true;
  }
  function minutes(m) { return !isNum(m) ? '-' : m < 90 ? Math.round(m) + ' min' : m < 2880 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' days'; }
  function itemOf(part) { var o = obj(part); return o && obj(o.item) ? o.item : o; }

  function approvalButton(row, label, aria, primary, run) {
    var b = el('button', 'btn' + (primary ? ' primary' : ''), label); b.type = 'button'; b.setAttribute('aria-label', aria);
    b.addEventListener('click', run);
    row.appendChild(b);
  }

  function pageApprovals(box, parts) {
    box.appendChild(el('h2', null, 'Approvals'));
    note(box, 'What you are being asked, and the standing rules that could ask less of you. Accept shows you what would be granted and waits for your Apply; nothing here changes anything by itself. You can also say any of it in the chat.');
    var load = itemOf(parts.load);
    if (!failed(box, 'Approval load', parts.load) && load) {
      var sec = region(box, 'Approval load, last ' + (isNum(load.days) ? load.days : '?') + ' days');
      var by = obj(load.decidedBy) || {};
      sec.appendChild(el('div', 'card-line', 'You decided ' + (isNum(load.ownerDecisions) ? load.ownerDecisions : 0) + ' times; agents decided ' + (isNum(load.agentDecisions) ? load.agentDecisions : 0) + ' times. Average wait for you: ' + minutes(load.averageOwnerWaitMinutes) + '.'));
      table(sec, 'How actions were decided', ['Decided by', 'Actions'], [['A rule', by.rule], ['A standing grant', by.grant], ['An agent review', by.agentReview], ['You', by.owner], ['Denied', by.denied]].map(function (r) { return [r[0], isNum(r[1]) ? String(r[1]) : '0']; }));
      var days = list(load.perDay, 90);
      if (days.length) table(sec, 'Decisions per day', ['Day', 'By you', 'By agents'], days.map(function (d) { d = obj(d) || {}; return [clip(d.day, 40), isNum(d.ownerDecisions) ? String(d.ownerDecisions) : '0', isNum(d.agentDecisions) ? String(d.agentDecisions) : '0']; }));
      var waiting = list(load.pending, 200);
      var count = isNum(load.pendingCount) ? load.pendingCount : waiting.length;
      var w = region(box, 'Asks still waiting (' + count + ')');
      if (!waiting.length) note(w, 'Nothing is waiting for a decision.');
      else {
        table(w, 'Asks still waiting, longest first', ['Agent', 'Wants to use', 'Project', 'Waiting on', 'Waiting'], waiting.map(function (p) { p = obj(p) || {}; return [clip(p.requester, 120), clip(p.tool, 120), clip(p.projectId, 120), clip(p.waitingOn, 120), minutes(p.waitingMinutes)]; }));
        if (count > waiting.length) note(w, 'Showing the first ' + waiting.length + ' of ' + count + '.');
      }
    }
    if (!failed(box, 'Standing-rule proposals', parts.proposals)) {
      var items = list(obj(parts.proposals) && parts.proposals.items, 50).map(obj).filter(function (p) { return p && p.state === 'open' && typeof p.id === 'string'; });
      var psec = region(box, 'Standing-rule proposals (' + items.length + ' open)');
      if (!items.length) note(psec, 'No proposal is waiting. One is offered when you approve the same kind of action for the same agent in the same project three times.');
      items.forEach(function (p) {
        var card = el('div', 'card');
        var who = clip(p.requester, 120) + ' in project ' + clip(p.projectId, 120) + ' (' + clip(p.environment, 40) + ')';
        card.appendChild(el('h4', 'card-title', clip(p.cls, 120) + ' for ' + who));
        card.appendChild(el('div', 'card-line', 'You approved this ' + (isNum(p.count) ? p.count : '?') + ' times. Accepting would let it stand without asking, for a limited time, in this project and environment only.'));
        var dl = obj(p.defaultLength), sg = obj(p.suggestion);
        var suggested = dl && isNum(dl.days) ? dl.days : sg && isNum(sg.days) ? sg.days : null;
        if (suggested !== null) card.appendChild(el('div', 'card-line', 'Suggested length: ' + suggested + ' days' + (dl && dl.why ? ' - ' + clip(dl.why, 300) : '')));
        list(p.covered, 5).forEach(function (c) { c = obj(c) || {}; card.appendChild(el('div', 'meta', 'Approved: ' + clip(c.tool, 120) + (c.at ? ' at ' + clip(c.at, 40) : ''))); });
        var row = el('div', 'row');
        var offered = list(p.lengthOptions, 8).filter(function (d) { return d === 1 || d === 7 || d === 30 || d === 90; });
        if (!offered.length && suggested !== null && (suggested === 1 || suggested === 7 || suggested === 30 || suggested === 90)) offered = [suggested];
        offered.forEach(function (d) {
          var lbl = 'Accept for ' + d + (d === 1 ? ' day' : ' days') + (d === suggested ? ' (suggested)' : '');
          approvalButton(row, lbl, lbl + ': ' + clip(p.cls, 60) + ' for ' + clip(p.requester, 60), d === suggested, function () { client.approval(p.id, 'accept', d, 'Accept standing-rule proposal for ' + clip(p.requester, 60) + ' for ' + d + ' days'); show('chat'); });
        });
        approvalButton(row, 'Dismiss', 'Dismiss the proposal: ' + clip(p.cls, 60) + ' for ' + clip(p.requester, 60), false, function () {
          if (root.confirm('Turn this proposal down? It is not offered again for 30 days.')) { client.approval(p.id, 'dismiss', undefined, 'Dismiss standing-rule proposal for ' + clip(p.requester, 60)); show('chat'); }
        });
        card.appendChild(row);
        psec.appendChild(card);
      });
    }
    if (!failed(box, 'Derived-profile question', parts.suggestion)) {
      var sug = itemOf(parts.suggestion);
      var ssec = region(box, 'Move to the derived profile?');
      if (sug && sug.due === true) {
        note(ssec, 'You are due to be asked, and nothing is switched until you answer.');
        list(sug.preview, 12).forEach(function (l) { ssec.appendChild(el('div', 'card-line', clip(l, 400))); });
        ssec.appendChild(el('div', 'card-line', 'To answer, tell the chat: ' + list(sug.answers, 8).map(function (a) { return clip(a, 20); }).join(', ') + '.'));
      } else note(ssec, 'No question is due.');
    }
  }

  function sourceOf(v) { return isNum(v) ? 'set by you' : 'not set: the agent\'s runtime decides'; }
  function pageModels(box, parts) {
    box.appendChild(el('h2', null, 'Models'));
    note(box, 'The model routes in use, what limits each has and where every value comes from. This page only shows them; to change one, say so in the chat.');
    var routes = itemOf(parts.routes);
    if (!failed(box, 'Routes', parts.routes)) {
      var rows = list(routes && routes.routes, 200).map(obj).filter(Boolean);
      var sec = region(box, 'Providers and routes (' + rows.length + ')');
      if (!rows.length) note(sec, 'No routing table has been set up yet. Ask the chat to set up the model providers.');
      else {
        var perProvider = Object.create(null); // provider names such as constructor or __proto__ are names, not the object's own fields (review)
        rows.forEach(function (r) { var name = clip(r.route, 200).split('/')[0]; perProvider[name] = (perProvider[name] || 0) + 1; });
        table(sec, 'Providers', ['Provider', 'Routes'], Object.keys(perProvider).sort().map(function (k) { return [k, String(perProvider[k])]; }));
        table(sec, 'Routes with their effective values and where each comes from', ['Route', 'Context window', 'Reply limit', 'Reasoning cap'], rows.map(function (r) {
          return [clip(r.route, 200), isNum(r.contextTokens) ? r.contextTokens + ' tokens (from the routing table)' : '-', isNum(r.maxTokens) ? r.maxTokens + ' tokens (' + sourceOf(r.maxTokens) + ')' : sourceOf(r.maxTokens), isNum(r.reasoningTokens) ? r.reasoningTokens + ' tokens (' + sourceOf(r.reasoningTokens) + ')' : sourceOf(r.reasoningTokens)];
        }));
      }
    }
    if (!failed(box, 'Switched off', parts.controls)) {
      var ctl = obj(parts.controls && parts.controls.controls) || {};
      var entries = list(ctl.entries, 100).map(obj).filter(Boolean);
      var csec = region(box, 'Switched off or moving (' + entries.length + ')');
      if (!entries.length) note(csec, 'Every route is in service.');
      else table(csec, 'Routing controls in force', ['Target', 'Level', 'What', 'Why', 'Since'], entries.map(function (e) { return [clip(e.name, 160), clip(e.level, 40), clip(e.mode, 40), clip(e.reason, 300), clip(e.since || e.at, 40)]; }));
    }
    if (!failed(box, 'Route state', parts.state)) {
      var st = itemOf(parts.state);
      var lines = st && Array.isArray(st.lines) ? st.lines.map(function (l) { return typeof l === 'string' ? l : l && typeof l.text === 'string' ? l.text : ''; }).filter(Boolean).slice(0, 40) : [];
      if (lines.length) { var ssec = region(box, 'What the controller says about the routes'); lines.forEach(function (l) { ssec.appendChild(el('div', 'card-line', clip(l, 400))); }); }
    }
    // Profiles never set read as "not found": that is a state, not a failure.
    var noProfiles = parts.difficulty && obj(parts.difficulty.error) && parts.difficulty.error.code === 'not_found';
    if (noProfiles || !failed(box, 'Difficulty profiles', parts.difficulty)) {
      var dp = noProfiles ? null : itemOf(parts.difficulty);
      var dsec = region(box, 'How work is run by difficulty');
      var profiles = obj(dp && dp.profiles) || {};
      var names = Object.keys(profiles).sort().slice(0, 50);
      if (!names.length) note(dsec, 'No difficulty profiles are set: a task is run the way its project says. Nothing is invented for you.');
      else {
        table(dsec, 'Profiles. Every value was set by you', ['Profile', 'Harness', 'Route', 'Routing profile', 'Reasoning', 'Context', 'Spend limit'], names.map(function (n) {
          var p = obj(profiles[n]) || {}; var rs = obj(p.reasoning) || {};
          return [clip(n, 80), clip(p.harness, 80) || '-', p.provider || p.model ? clip(p.provider, 80) + '/' + clip(p.model, 80) : '-', clip(p.routingProfile, 80) || '-', clip(rs.effort, 20) || (isNum(rs.maxThinkingTokens) ? rs.maxThinkingTokens + ' thinking tokens' : '-'), isNum(p.contextTokens) ? p.contextTokens + ' tokens' : '-', isNum(p.spendLimitMicros) ? (p.spendLimitMicros === 0 ? 'no paid route' : p.spendLimitMicros + ' micro') : '-'];
        }));
        var map = obj(dp.mapping) || {};
        table(dsec, 'Which profile each difficulty uses', ['Difficulty', 'Profile'], Object.keys(map).sort().slice(0, 20).map(function (k) { return [clip(k, 40), clip(map[k], 80)]; }));
      }
    }
    // The switch for collecting the model's thinking (card U09b). Shown only when the controller answered the part; it changes nothing until the owner agrees, and then it is the chat's own command.
    if (parts.thinking !== undefined) {
      var unwired = obj(parts.thinking.error) && parts.thinking.error.code === 'unavailable';
      if (unwired) { note(region(box, 'The model\'s thinking'), 'This controller runs without the store for the model\'s thinking, so nothing is collected.'); }
      else if (!failed(box, 'The model\'s thinking', parts.thinking)) {
        var th = itemOf(parts.thinking);
        var tsec = region(box, 'The model\'s thinking');
        if (!th || typeof th.enabled !== 'boolean') note(tsec, 'Not known.');
        else {
          var on = th.enabled === true;
          tsec.appendChild(el('div', 'card-line', on ? 'Collected: the thinking of agents that work is kept, readable only by you, with credentials hidden, until the retention rule removes it.' : 'Not collected: nothing more is kept from the agents\' work. What was kept stays until the retention rule removes it.'));
          var trow = el('div', 'row');
          var tlabel = on ? 'Stop collecting the thinking' : 'Collect the thinking again';
          approvalButton(trow, tlabel, tlabel + ' of the agents\' models', false, function () {
            if (root.confirm(on ? 'Stop collecting the model\'s thinking? What was kept stays until retention removes it.' : 'Collect the model\'s thinking again from now on?')) { client.thinking(!on, on ? 'Turn collecting the model\'s thinking off' : 'Turn collecting the model\'s thinking on'); show('chat'); }
          });
          tsec.appendChild(trow);
        }
      }
    }
  }

  // ---- the replay page (card U09b): read only, one task at a time -------------------------------------------------------------------
  // Summary first, then the steps in lanes side by side, one step in full with what it cites, and the model's thinking collapsed behind a button that says it is model output. Every text is an agent's or the
  // controller's words and is set as text; labels come from the controller (REPLAY_LABELS), so the page invents none. The simulation is its own button and says it changes nothing.
  var rp = { taskId: null, filters: {} };
  function ok200(r) { return r && r.status === 200 && r.body; }
  function failLine(parent, r) { parent.appendChild(el('p', 'error', 'Could not load: ' + clip((r && r.body && r.body.error && r.body.error.message) || (r && r.status) || 'offline', 300))); }
  function backTo(box, label, run) { var b = el('button', 'btn', label); b.type = 'button'; b.addEventListener('click', run); box.appendChild(b); }
  function stepWords(s) {
    return 'Step ' + s.seq + ' - ' + clip(s.kind, 40) + ' - ' + clip(s.actor, 80) + ' - ' + clip(s.outcome === 'not-recorded' ? 'not recorded' : s.outcome, 20) + (s.outcomeNote ? ' (' + clip(s.outcomeNote, 80) + ')' : '') + (s.authority === 'superseded' ? ' - replaced by step ' + list(s.supersededBy, 5).join(', ') : '');
  }
  function pageReplay(box, parts) {
    box.appendChild(el('h2', null, 'Replay'));
    note(box, 'Step through what happened on one task, as it was recorded. Nothing here runs, sends or changes anything.');
    if (rp.taskId) { openReplay(box); return; }
    var tasks = obj(parts.tasks) ? list(parts.tasks.items, 50) : [];
    var sec = region(box, 'Choose a task');
    if (failed(box, 'Tasks', parts.tasks)) return;
    if (!tasks.length) note(sec, 'There are no tasks yet.');
    tasks.forEach(function (t) {
      var row = el('div', 'row');
      row.appendChild(el('span', 'card-line', clip(t.title, 120) + ' (' + clip(t.state, 30) + ')'));
      var b = el('button', 'btn', 'Replay'); b.type = 'button'; b.setAttribute('aria-label', 'Replay the task ' + clip(t.title, 80));
      b.addEventListener('click', function () { rp.taskId = t.id; rp.filters = {}; renderView('replay'); });
      row.appendChild(b); sec.appendChild(row);
    });
  }
  function openReplay(box) {
    backTo(box, 'Back to the tasks', function () { rp.taskId = null; renderView('replay'); });
    var body = el('div'); box.appendChild(body); body.appendChild(el('p', 'meta', 'Loading...'));
    client.replay(rp.taskId, rp.filters).then(function (r) {
      clear(body);
      if (!ok200(r)) { failLine(body, r); return; }
      drawReplay(body, r.body.replay || {}, r.body.labels || {});
    }, function () { clear(body); note(body, 'Offline. Try again when the connection is back.'); });
  }
  function drawReplay(body, v, labels) {
    var sm = obj(v.summary) || {};
    var sec = region(body, 'Summary');
    sec.appendChild(el('div', 'card-line', (isNum(sm.total) ? sm.total : 0) + ' steps; ' + list(sm.lanes, 100).length + ' lines of work; ' + list(sm.unavailable, 1000).length + ' unavailable; ' + (isNum(sm.superseded) ? sm.superseded : 0) + ' replaced; ' + (isNum(sm.corrected) ? sm.corrected : 0) + ' corrected; ' + (isNum(sm.redactedSteps) ? sm.redactedSteps : 0) + ' with hidden content.'));
    var oc = obj(sm.byOutcome) || {};
    sec.appendChild(el('div', 'card-line', 'Where steps stood: ' + Object.keys(oc).slice(0, 8).map(function (k) { return clip(k === 'not-recorded' ? 'not recorded' : k, 20) + ' ' + (isNum(oc[k]) ? oc[k] : 0); }).join(', ') + '.'));
    if (sm.scanLimited && labels.windowed) note(sec, clip(labels.windowed, 300));
    // Lines of work and agents to follow: each narrows the window; nothing is hidden from the summary.
    var follow = region(body, 'Follow a line of work or an agent');
    var chips = el('div', 'chips'); follow.appendChild(chips);
    function chip(text, aria, f) { var b = el('button', 'chip', text); b.type = 'button'; b.setAttribute('aria-label', aria); b.addEventListener('click', f); chips.appendChild(b); }
    list(sm.lanes, 20).forEach(function (l) { chip('Line ' + clip(l.lane, 40) + ' (' + l.steps + ')', 'Show only the line ' + clip(l.lane, 40), function () { rp.filters.lane = l.lane; renderView('replay'); }); });
    list(sm.agents, 20).forEach(function (a) { chip(clip(a.actor, 40) + ' (' + a.steps + ')', 'Show only the steps of ' + clip(a.actor, 40), function () { rp.filters.actor = a.actor; renderView('replay'); }); });
    chip('Show everything', 'Remove the filters', function () { rp.filters = {}; renderView('replay'); });
    if (Object.keys(rp.filters).length) note(follow, 'Showing only: ' + Object.keys(rp.filters).map(function (k) { return k + ' ' + clip(rp.filters[k], 40); }).join(', ') + '.');
    // The lanes side by side. Steps on different lines are concurrent: their numbers are the order they were recorded in.
    var lanes = Object.create(null); var order = [];
    list(v.entries, 200).forEach(function (e) {
      var lane = e.unavailable !== undefined ? 'unavailable' : (e.lane || 'main');
      if (!lanes[lane]) { lanes[lane] = []; order.push(lane); }
      lanes[lane].push(e);
    });
    var ls = region(body, 'Steps');
    if (order.length > 1 && labels.concurrent) note(ls, clip(labels.concurrent, 300));
    var grid = el('div', 'lanes'); ls.appendChild(grid);
    order.slice(0, 8).forEach(function (lane) {
      var col = el('div', 'lane'); col.setAttribute('role', 'group'); col.setAttribute('aria-label', 'Line ' + clip(lane, 40));
      col.appendChild(el('h4', null, 'Line ' + clip(lane, 40) + (lanes[lane][0] && lanes[lane][0].laneNote ? ' (' + clip(lanes[lane][0].laneNote, 40) + ')' : '')));
      lanes[lane].forEach(function (e) {
        if (e.unavailable !== undefined) { col.appendChild(el('div', 'card-line', 'Step ' + e.seq + ' is no longer available: ' + clip(e.unavailable, 200))); return; }
        var b = el('button', 'btn' + (e.authority === 'superseded' ? ' faded' : ''), stepWords(e)); b.type = 'button';
        b.setAttribute('aria-label', 'Open ' + stepWords(e));
        b.addEventListener('click', function () { openStep(body, e.seq, labels); });
        col.appendChild(b);
        col.appendChild(el('div', 'meta', clip(e.summary, 300)));
        if (e.authority === 'superseded' && labels.superseded) col.appendChild(el('div', 'meta', clip(labels.superseded, 200)));
      });
      grid.appendChild(col);
    });
    if (!order.length) note(ls, 'No step in this window matches.');
    if (isNum(v.next)) { var more = el('button', 'btn', 'Show the next steps (from step ' + v.next + ')'); more.type = 'button'; more.addEventListener('click', function () { rp.filters.from = String(v.next); renderView('replay'); }); ls.appendChild(more); }
    if (v.note) note(ls, clip(v.note, 300));
    // A search over the summaries of the steps (stored content is not searched).
    var ss = region(body, 'Search the steps');
    var q = el('input'); q.type = 'text'; q.setAttribute('aria-label', 'Words to look for in the steps');
    var go = el('button', 'btn', 'Search'); go.type = 'button';
    var found = el('div'); ss.appendChild(q); ss.appendChild(go); ss.appendChild(found);
    go.addEventListener('click', function () {
      clear(found);
      client.replaySearch(rp.taskId, q.value).then(function (r) {
        if (!ok200(r)) { failLine(found, r); return; }
        var m = list(r.body.search && r.body.search.matches, 20);
        if (!m.length) note(found, 'No step matches.');
        m.forEach(function (e) { found.appendChild(el('div', 'card-line', stepWords(e) + ': ' + clip(e.summary, 200))); });
      });
    });
    drawSimulation(body);
  }
  function openStep(body, seq, labels) {
    var sec = region(body, 'Step ' + seq + ' in full');
    var loading = el('p', 'meta', 'Loading...'); sec.appendChild(loading);
    client.replayStep(rp.taskId, seq).then(function (r) {
      sec.removeChild(loading);
      if (!ok200(r)) { failLine(sec, r); return; }
      var d = obj(r.body.detail) || {}; var s = obj(d.step) || {};
      sec.appendChild(el('div', 'card-line', stepWords(s) + ' - ' + clip(s.at, 40)));
      sec.appendChild(el('div', 'card-line', clip(s.summary, 400)));
      if (s.lane && s.lane !== 'main') sec.appendChild(el('div', 'meta', 'Line ' + clip(s.lane, 40) + (s.laneNote ? ' (' + clip(s.laneNote, 40) + ')' : '')));
      if (s.authority === 'superseded' && labels.superseded) sec.appendChild(el('div', 'meta', clip(labels.superseded, 200)));
      var vt = obj(s.versionsThen) || {};
      sec.appendChild(el('div', 'card-line', vt.state === 'recorded' ? 'Context then: ' + (list(vt.refs, 20).map(function (x) { return clip(x.kind, 30) + ' ' + clip(x.id, 60) + (x.version ? ' @' + clip(x.version, 30) : ''); }).join(', ') || 'none listed') : 'Context then: not recorded' + (vt.reason ? ' (' + clip(vt.reason, 200) + ')' : '')));
      var ex = obj(d.explanations) || {};
      ['contemporaneous', 'retrospective'].forEach(function (k) {
        var g = obj(ex[k]) || {};
        list(g.items, 10).forEach(function (e) { sec.appendChild(el('div', 'card-line', clip(g.label, 120) + ' ' + clip(e.by, 60) + ' chose ' + clip(e.choice, 300) + '. Uncertain: ' + clip(e.uncertainty, 200))); });
      });
      // What the step cites, read for you where you may read it: each record's own words, marked when an agent or a reviewer wrote them.
      var lk = obj(r.body.links) || {};
      var ls = region(sec, 'What it cites and what led to it');
      var items = list(lk.items, 30);
      if (!items.length) note(ls, 'Nothing is linked.');
      items.forEach(function (i) {
        var res = obj(i.resolution) || {};
        var head = clip(i.relation, 20) + ': ' + (i.kind ? clip(i.kind, 30) + ' ' + clip(i.id, 60) : 'step ' + i.seq);
        if (res.state === 'readable') {
          ls.appendChild(el('div', 'card-line', head + ' - ' + clip(res.title, 200)));
          list(res.lines, 8).forEach(function (l) { ls.appendChild(el('div', 'meta', (res.untrusted ? 'Written by an agent or reviewer: ' : '') + clip(l, 400))); });
        } else ls.appendChild(el('div', 'card-line', head + ' - ' + clip(res.note || (i.note ? i.note : 'a reference'), 200)));
      });
      drawThinking(sec, d, labels);
    });
  }
  function drawThinking(sec, d, labels) {
    var t = region(sec, 'The model\'s thinking');
    var th = obj(d.thinking);
    if (th && (th.state === 'removed-by-retention' || th.state === 'unavailable')) { note(t, clip(th.label, 300)); return; }
    note(t, 'Collapsed. It is model output, not an explanation of any step. Opening it is recorded as a look.');
    var out = el('div');
    var b = el('button', 'btn', 'Expand the model\'s thinking'); b.type = 'button'; b.setAttribute('aria-label', 'Expand the model\'s thinking for this task (recorded as a look)');
    b.addEventListener('click', function () {
      b.disabled = true; clear(out);
      client.replayThinking(rp.taskId).then(function (r) {
        b.disabled = false;
        if (!ok200(r)) { failLine(out, r); return; }
        var x = obj(r.body.thinking) || {};
        note(out, clip(x.label || labels.thinking, 300));
        list(x.blocks, 20).forEach(function (blk) { out.appendChild(el('div', 'card-line', clip(blk.text !== undefined ? blk.text : '(kept without text)', 700))); });
        if (x.state === 'stored' && !list(x.blocks, 1).length) note(out, 'Nothing more is kept.');
      });
    });
    t.appendChild(b); t.appendChild(out);
  }
  function drawSimulation(body) {
    var sec = region(body, 'Simulate a rerun');
    note(sec, 'A walk through the recorded steps in an isolated scope. Nothing is run, sent, spent or changed.');
    var out = el('div');
    var b = el('button', 'btn', 'Simulate a rerun'); b.type = 'button';
    b.addEventListener('click', function () {
      if (!root.confirm('Walk through this task\'s recorded steps as a simulation? Nothing will be run or changed.')) return;
      b.disabled = true; clear(out);
      client.replaySimulate(rp.taskId, {}).then(function (r) {
        b.disabled = false;
        if (!ok200(r)) { failLine(out, r); return; }
        var sim = obj(r.body.simulation) || {};
        note(out, clip(sim.label, 300));
        list(sim.steps, 200).forEach(function (s) { out.appendChild(el('div', 'card-line', 'Simulated: step ' + s.seq + ' would ' + clip(s.would, 120) + ' (recorded: ' + clip(s.recordedOutcome, 20) + ')')); });
        if (sim.truncated) note(out, 'Only the first steps were walked.');
      });
    });
    sec.appendChild(b); sec.appendChild(out);
  }
  var PAGES = { approvals: pageApprovals, models: pageModels, replay: pageReplay };

  function renderView(name) {
    var box = $('view');
    clear(box);
    box.appendChild(el('p', 'meta', 'Loading...'));
    client.view(name).then(function (r) {
      clear(box);
      if (r.status !== 200) { box.appendChild(el('p', 'meta', r.status === 401 ? 'Signed out.' : 'Could not load: ' + ((r.body && r.body.error && r.body.error.message) || r.status))); return; }
      box.appendChild(el('p', 'meta', 'As of ' + r.body.observedAt));
      if (PAGES[name]) { PAGES[name](box, r.body.parts || {}); return; }
      var any = false;
      Object.keys(r.body.parts).forEach(function (key) {
        var lines = linesOf(r.body.parts[key]);
        if (!lines.length) return;
        any = true;
        var card = el('div', 'card');
        card.appendChild(el('div', 'card-title', key));
        lines.slice(0, 120).forEach(function (l) { card.appendChild(el('div', 'card-line', l)); });
        box.appendChild(card);
      });
      if (!any) box.appendChild(el('p', 'meta', 'Nothing to show.'));
      if (name === 'recovery') renderRecoveryActions(box);
    }, function () { clear(box); box.appendChild(el('p', 'meta', 'Offline. Try again when the connection is back.')); });
  }

  function renderRecoveryActions(box) {
    var card = el('div', 'card');
    card.appendChild(el('div', 'card-title', 'Recovery orders'));
    card.appendChild(el('div', 'card-line', 'These run as typed and do not need the assistant. You can also just say what you want in the chat.'));
    [['Pause everything', '/nimblenewt.lifecycle-pause {"scope": {"kind": "installation", "id": "installation"}, "reason": "paused from the phone"}', 'Pause all work now?'], ['Resume', '/nimblenewt.lifecycle-resume {"scope": {"kind": "installation", "id": "installation"}, "reason": "resumed from the phone"}', 'Resume work?']].forEach(function (a) {
      var b = el('button', 'btn', a[0]); b.type = 'button';
      b.addEventListener('click', function () { if (root.confirm(a[2])) { client.say(a[1]); show('chat'); } });
      card.appendChild(b);
    });
    box.appendChild(card);
  }

  function settingsCard(st) {
      if (st.status !== 200 || !st.body) return null;
      var b = st.body;
      var card = el('div', 'card');
      card.appendChild(el('div', 'card-title', 'How this web chat is set up'));
      var proxy = b.trustedProxy && b.trustedProxy.enabled ? 'trusted proxy ' + (b.trustedProxy.addresses || []).join(', ') + ' (client address from ' + b.trustedProxy.header + ')' : 'no trusted proxy: every client is the connection\'s own address';
      [
        'Listens on ' + b.host + ':' + b.port + ' (' + (b.network === 'loopback' ? 'this machine only' : 'your private network') + ')',
        b.tls ? 'TLS of its own' : b.behindTlsProxy ? 'Behind a TLS proxy on this machine' : 'Plain HTTP',
        'Host names: ' + ((b.publicHosts || []).join(', ') || 'none'),
        proxy,
        'Your connection arrives as ' + b.yourAddress + (b.addressFromProxy ? ' (from the proxy header)' : ''),
        'Sign-in limits: ' + b.limits.failedLoginsPerAddressPerMinute + ' failures a minute per address, ' + b.limits.failedLoginsGlobalPerMinute + ' in all',
        'The address, the network and the proxy are set when the controller starts.'
      ].forEach(function (l) { card.appendChild(el('div', 'card-line', l)); });
      return card;
  }

  function renderSessions() {
    var box = $('view');
    clear(box);
    Promise.all([client.settings(), client.sessions()]).then(function (both) {
      var r = both[1];
      clear(box);
      box.appendChild(el('h2', null, 'Settings'));
      var sc = settingsCard(both[0]);
      if (sc) box.appendChild(sc);
      box.appendChild(el('h2', null, 'Signed-in browsers'));
      ((r.body && r.body.sessions) || []).forEach(function (s) {
        var card = el('div', 'card');
        card.appendChild(el('div', 'card-title', s.label + (s.current ? ' (this one)' : '')));
        card.appendChild(el('div', 'card-line', 'Last used ' + s.lastSeen));
        if (!s.current) { var b = el('button', 'btn', 'Sign it out'); b.type = 'button'; b.addEventListener('click', function () { client.revoke({ handle: s.handle }).then(renderSessions); }); card.appendChild(b); }
        box.appendChild(card);
      });
      var all = el('button', 'btn', 'Sign out all other browsers'); all.type = 'button';
      all.addEventListener('click', function () { client.revoke({ all: true }).then(renderSessions); });
      box.appendChild(all);
      var pair = el('button', 'btn', 'Show a pairing code for another browser'); pair.type = 'button';
      var out = el('p', 'meta');
      pair.addEventListener('click', function () { client.pair().then(function (p) { out.textContent = p.status === 201 ? 'Code ' + p.body.code + ' - works once, until ' + p.body.expiresAt : 'Could not make a code.'; }); });
      box.appendChild(pair); box.appendChild(out);
      var off = el('button', 'btn danger', 'Sign out of this browser'); off.type = 'button';
      off.addEventListener('click', function () { client.logout(); });
      box.appendChild(off);
    });
  }

  function show(name) {
    tab = name;
    $('chat').hidden = name !== 'chat';
    $('view').hidden = name === 'chat';
    Array.prototype.forEach.call(doc.querySelectorAll('[data-tab]'), function (b) { b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === name)); });
    if (name === 'chat') renderChat(); else if (name === 'sessions') renderSessions(); else renderView(name);
  }

  function build() {
    var tabs = $('tabs');
    var names = [['chat', 'Chat']].concat(Object.keys(VIEW_TABS).map(function (k) { return [k, VIEW_TABS[k]]; })).concat([['sessions', 'Settings']]);
    names.forEach(function (n) {
      var b = el('button', 'tab', n[1]); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('data-tab', n[0]);
      b.addEventListener('click', function () { show(n[0]); });
      tabs.appendChild(b);
    });
    [['What needs me?', 'What needs my attention right now?'], ['Status', 'Give me a short status of all projects.'], ['Cost so far', 'What has been spent so far?']].forEach(function (c) {
      var b = el('button', 'chip', c[0]); b.type = 'button';
      b.addEventListener('click', function () { client.say(c[1]); });
      $('chips').appendChild(b);
    });
    $('composer').addEventListener('submit', function (e) {
      e.preventDefault();
      var box = $('text'); var text = box.value.trim();
      if (!text) return;
      box.value = ''; box.style.height = '';
      client.say(text);
    });
    $('text').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && root.matchMedia && !root.matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('composer').requestSubmit(); } });
    $('text').addEventListener('input', function () { var t = $('text'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; });
    $('login').addEventListener('submit', function (e) {
      e.preventDefault();
      var value = $('secret').value.trim();
      if (!value) return;
      var credential = $('mode').value === 'code' ? { code: value } : { token: value };
      $('secret').value = '';
      $('gate-error').textContent = '';
      client.login(credential).then(function (r) { if (r.status !== 200) $('gate-error').textContent = r.status === 429 ? 'Too many attempts. Wait a minute.' : 'That was not accepted.'; else show('chat'); }, function () { $('gate-error').textContent = 'Could not reach the controller.'; });
    });
    client.onChange(function () { renderGate(); if (tab === 'chat' && client.state.signedIn) renderChat(); });
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'visible') client.resume(); });
    root.addEventListener('online', function () { client.resume(); });
    root.addEventListener('offline', function () { client.state.online = false; renderGate(); });
    root.addEventListener('pageshow', function () { client.resume(); });
    client.session().then(function () { renderGate(); show('chat'); client.flush(); });
  }
  build();
})(typeof globalThis !== 'undefined' ? globalThis : this);
`;
