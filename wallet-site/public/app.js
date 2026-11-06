(() => {
  'use strict';

  const root = document.getElementById('app');
  const state = { config: {}, me: null, tab: 'voucher', mode: 'login' };
  let pollTimer = null;

  // ───────── tiny helpers ─────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status });
    return data;
  }

  const money = (cents) =>
    (cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (iso) =>
    new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  function show(node) {
    clearInterval(pollTimer);
    root.replaceChildren(node);
  }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg ' + (kind || '');
    if (text) el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    const old = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = old; }, 1400);
  }

  function brand() {
    return h('div', { class: 'brand' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), state.config.appName || 'Wallet');
  }

  // ───────── sign in / create account ─────────
  function renderAuth() {
    const isNew = state.mode === 'register';
    const err = h('p', { class: 'msg' });
    const idInput = h('input', {
      type: 'text', id: 'identifier', name: 'username', autocomplete: 'username',
      autocapitalize: 'none', spellcheck: 'false', placeholder: 'you@example.com or 082 123 4567', required: true,
    });
    const pwInput = h('input', {
      type: 'password', id: 'password', name: 'password', required: true,
      autocomplete: isNew ? 'new-password' : 'current-password', placeholder: isNew ? 'At least 8 characters' : 'Your password',
    });
    const submit = h('button', { class: 'btn', type: 'submit' }, isNew ? 'Create account' : 'Sign in');

    const form = h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        setMsg(err, '');
        submit.disabled = true;
        try {
          await api(isNew ? '/api/register' : '/api/login', { identifier: idInput.value, password: pwInput.value });
          await loadWallet();
        } catch (ex) {
          setMsg(err, ex.message, 'err');
          submit.disabled = false;
        }
      },
    },
      h('label', { class: 'field' }, h('span', {}, 'Email or phone number'), idInput),
      h('label', { class: 'field' }, h('span', {}, 'Password'), pwInput),
      isNew && h('p', { class: 'hint' }, `Numbers starting with 0 are treated as +${state.config.countryCode || '27'}. Use + for other countries.`),
      err,
      submit,
    );

    const tab = (mode, label) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(state.mode === mode),
      onclick: () => { state.mode = mode; renderAuth(); },
    }, label);

    show(h('div', {},
      h('div', { class: 'topbar' }, brand()),
      h('div', { class: 'card' },
        h('div', { class: 'seg', role: 'tablist' }, tab('login', 'Sign in'), tab('register', 'Create account')),
        form,
      ),
      h('p', { class: 'muted hint' }, 'Your wallet is tied to the email or phone number you sign up with.'),
    ));
    idInput.focus();
  }

  // ───────── wallet ─────────
  let amountEl = null;
  let historyEl = null;
  let shownCents = 0;

  function paintBalance(cents, animate) {
    const from = shownCents;
    shownCents = cents;
    const set = (v) => amountEl.replaceChildren(h('span', { class: 'cur' }, state.config.currency || 'R'), money(v));
    if (!animate || from === cents || matchMedia('(prefers-reduced-motion: reduce)').matches) return set(cents);
    const start = performance.now();
    const step = (t) => {
      const p = Math.min((t - start) / 600, 1);
      set(Math.round(from + (cents - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function paintHistory(txns) {
    const cur = state.config.currency || 'R';
    historyEl.replaceChildren(txns.length === 0
      ? h('p', { class: 'empty' }, 'No activity yet. Add money with a voucher or Pay@ and it will show up here.')
      : h('ul', { class: 'txns' }, txns.map((t) => h('li', { class: 'txn' },
        h('span', { class: 'chip' }, t.type === 'payat' ? 'Pay@' : t.type === 'voucher' ? 'Voucher' : t.type),
        h('span', { class: 'what' }, h('b', {}, t.description), h('small', {}, when(t.created_at))),
        h('span', { class: 'plus' }, `+${cur}${money(t.amount)}`),
      ))));
  }

  async function refresh(animate = true) {
    const [me, tx] = await Promise.all([api('/api/me'), api('/api/transactions')]);
    state.me = me;
    if (amountEl) paintBalance(me.balance, animate);
    if (historyEl) paintHistory(tx.transactions);
  }

  function voucherPanel() {
    const msg = h('p', { class: 'msg' });
    const input = h('input', {
      type: 'text', class: 'mono', id: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
      maxlength: '19', placeholder: 'XXXX-XXXX-XXXX-XXXX', inputmode: 'text', 'aria-label': 'Voucher code',
    });
    input.addEventListener('input', () => {
      const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
      input.value = raw.match(/.{1,4}/g)?.join('-') || '';
    });
    const btn = h('button', { class: 'btn', type: 'submit' }, 'Add to wallet');
    return h('form', {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        setMsg(msg, '');
        if (!input.value.trim()) return setMsg(msg, 'Enter your voucher code.', 'err');
        btn.disabled = true;
        try {
          const r = await api('/api/vouchers/redeem', { code: input.value });
          input.value = '';
          setMsg(msg, `${state.config.currency}${money(r.amount)} added to your wallet.`, 'ok');
          await refresh();
        } catch (ex) {
          setMsg(msg, ex.message, 'err');
        } finally {
          btn.disabled = false;
        }
      },
    },
      h('label', { class: 'field' }, h('span', {}, 'Voucher code'), input),
      msg,
      btn,
    );
  }

  function payatPanel() {
    const cfg = state.config;
    const ref = state.me.reference;
    const checkMsg = h('p', { class: 'msg' });

    if (!cfg.payatEnabled) {
      return h('p', { class: 'muted' }, 'Paying with Pay@ is not switched on for this wallet yet. Vouchers work in the meantime.');
    }

    const checkBtn = h('button', {
      class: 'btn ghost', type: 'button',
      onclick: async () => {
        checkBtn.disabled = true;
        try {
          const before = state.me.balance;
          await refresh();
          setMsg(checkMsg, state.me.balance > before ? 'Payment received. Your balance is updated.' : 'No new payment yet. This page also checks by itself.', state.me.balance > before ? 'ok' : '');
        } catch (ex) { setMsg(checkMsg, ex.message, 'err'); }
        checkBtn.disabled = false;
      },
    }, 'Check for my payment');

    const demo = cfg.demo && (() => {
      const amt = h('input', { type: 'number', inputmode: 'decimal', min: '1', step: '0.01', placeholder: '100.00', 'aria-label': 'Demo amount' });
      const msg = h('p', { class: 'msg' });
      return h('form', {
        class: 'demo-box', novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          setMsg(msg, '');
          try { await api('/api/dev/simulate-payat', { amount: amt.value }); amt.value = ''; await refresh(); setMsg(msg, 'Demo payment credited.', 'ok'); }
          catch (ex) { setMsg(msg, ex.message, 'err'); }
        },
      },
        h('div', { class: 'banner' }, 'Demo mode: this button pretends Pay@ paid. It only exists while testing.'),
        h('label', { class: 'field' }, h('span', {}, `Simulate a Pay@ payment (${cfg.currency})`), amt),
        msg,
        h('button', { class: 'btn ghost', type: 'submit' }, 'Simulate payment'),
      );
    })();

    return h('div', {},
      h('ol', { class: 'steps' },
        h('li', {}, 'Choose Pay@ and enter your wallet reference below as the account number.'),
        h('li', {}, 'Pay any amount at a Pay@ payment point, or on the Pay@ portal.'),
        h('li', {}, 'Your balance updates here once Pay@ confirms the payment.'),
      ),
      h('div', { class: 'ref' },
        h('div', {}, h('small', {}, 'Your wallet reference'), h('code', {}, ref)),
        h('button', { class: 'btn small ghost', type: 'button', onclick: (e) => copy(ref, e.currentTarget) }, 'Copy'),
      ),
      cfg.payatPortalUrl && h('p', {}, h('a', { class: 'btn', href: cfg.payatPortalUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open Pay@ portal')),
      checkMsg,
      checkBtn,
      demo,
    );
  }

  function renderWallet() {
    const me = state.me;
    amountEl = h('div', { class: 'amount', 'aria-live': 'polite' });
    historyEl = h('div', {});
    shownCents = me.balance;
    paintBalance(me.balance, false);

    const panel = h('div', {});
    const draw = () => { panel.replaceChildren(state.tab === 'voucher' ? voucherPanel() : payatPanel()); };
    const tabs = h('div', { class: 'seg', role: 'tablist' });
    const drawTabs = () => {
      tabs.replaceChildren(
        ...[['voucher', 'Voucher'], ['payat', 'Pay with Pay@']].map(([key, label]) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(state.tab === key),
          onclick: () => { state.tab = key; drawTabs(); draw(); },
        }, label)),
      );
    };
    drawTabs();
    draw();

    show(h('div', {},
      h('div', { class: 'topbar' },
        brand(),
        h('div', { class: 'who' },
          h('span', { class: 'id' }, me.identifier),
          h('button', {
            class: 'linkbtn', type: 'button',
            onclick: async () => { await api('/api/logout', {}); state.me = null; state.mode = 'login'; renderAuth(); },
          }, 'Sign out'),
        ),
      ),
      h('section', { class: 'card hero' }, h('div', { class: 'label' }, 'Available balance'), amountEl),
      h('section', { class: 'card' }, h('h2', {}, 'Add money'), tabs, panel),
      h('section', { class: 'card' }, h('h2', {}, 'Activity'), historyEl),
    ));

    refresh(false).catch(() => {});
    pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh().catch((e) => { if (e.status === 401) renderAuth(); });
    }, 15000);
  }

  async function loadWallet() {
    state.me = await api('/api/me');
    renderWallet();
  }

  // ───────── start ─────────
  (async () => {
    try { state.config = await api('/api/config'); } catch { /* fall back to defaults */ }
    document.title = state.config.appName || 'Wallet';
    try { await loadWallet(); } catch { renderAuth(); }
  })();
})();
