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
      sessions: function () { return call('GET', '/web/sessions'); },
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
  var VIEW_TABS = { status: 'Status', 'needs-you': 'Needs you', blockers: 'Blockers', cost: 'Cost', recovery: 'Recovery' };

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
      if (item.kind === 'message') {
        list.appendChild(el('div', 'msg me', item.text));
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

  function renderView(name) {
    var box = $('view');
    clear(box);
    box.appendChild(el('p', 'meta', 'Loading...'));
    client.view(name).then(function (r) {
      clear(box);
      if (r.status !== 200) { box.appendChild(el('p', 'meta', r.status === 401 ? 'Signed out.' : 'Could not load: ' + ((r.body && r.body.error && r.body.error.message) || r.status))); return; }
      box.appendChild(el('p', 'meta', 'As of ' + r.body.observedAt));
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

  function renderSessions() {
    var box = $('view');
    clear(box);
    client.sessions().then(function (r) {
      clear(box);
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
    var names = [['chat', 'Chat']].concat(Object.keys(VIEW_TABS).map(function (k) { return [k, VIEW_TABS[k]]; })).concat([['sessions', 'Browsers']]);
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
