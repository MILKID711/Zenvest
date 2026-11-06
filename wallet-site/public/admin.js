(() => {
  'use strict';

  const root = document.getElementById('app');
  let cur = 'R';
  const store = {
    get() { try { return sessionStorage.getItem('adminKey') || ''; } catch { return ''; } },
    set(v) { try { sessionStorage.setItem('adminKey', v); } catch { /* private mode */ } },
    clear() { try { sessionStorage.removeItem('adminKey'); } catch { /* ignore */ } },
  };

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
      headers: { 'X-Admin-Key': store.get(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
    return data;
  }

  const money = (c) => `${cur}${(c / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const setMsg = (el, text, kind) => { el.textContent = text || ''; el.className = 'msg ' + (kind || ''); };

  function login(message) {
    const key = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Admin key', 'aria-label': 'Admin key' });
    const msg = h('p', { class: 'msg' });
    setMsg(msg, message, 'err');
    root.replaceChildren(
      h('div', { class: 'topbar' }, h('div', { class: 'brand' }, h('span', { class: 'mark' }), 'Voucher admin')),
      h('form', {
        class: 'card', novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          store.set(key.value);
          try { await api('/api/admin/summary'); dashboard(); } catch (ex) { store.clear(); setMsg(msg, ex.message, 'err'); }
        },
      },
        h('label', { class: 'field' }, h('span', {}, 'Admin key (ADMIN_KEY on the server)'), key),
        msg,
        h('button', { class: 'btn', type: 'submit' }, 'Open'),
      ),
    );
    key.focus();
  }

  function downloadCsv(codes, amountCents, batch) {
    const rows = ['code,amount', ...codes.map((c) => `${c},${(amountCents / 100).toFixed(2)}`)];
    const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }));
    const a = h('a', { href: url, download: `vouchers-${batch}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function dashboard() {
    const tiles = h('div', { class: 'tiles' });
    const listWrap = h('div', { class: 'tbl-wrap' });
    const result = h('div', {});

    async function load() {
      const [s, l] = await Promise.all([api('/api/admin/summary'), api('/api/admin/vouchers?limit=100')]);
      const tile = (label, value) => h('div', { class: 'tile' }, h('small', {}, label), h('b', {}, value));
      tiles.replaceChildren(
        tile('Wallet users', String(s.users)),
        tile('Money in wallets', money(s.totalBalance)),
        tile('Unredeemed vouchers', `${s.outstanding.n} · ${money(s.outstanding.v)}`),
        tile('Redeemed vouchers', `${s.redeemed.n} · ${money(s.redeemed.v)}`),
      );
      listWrap.replaceChildren(h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Ends in', 'Amount', 'Batch', 'Note', 'Created', 'Status', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, l.vouchers.map((v) => {
          const st = v.voided_at ? ['Voided', 'void'] : v.redeemed_at ? ['Used', 'used'] : ['Unused', 'open'];
          return h('tr', {},
            h('td', {}, h('code', {}, v.hint)), h('td', {}, money(v.amount)), h('td', {}, v.batch), h('td', {}, v.note || ''),
            h('td', {}, new Date(v.created_at).toLocaleDateString('en-GB')),
            h('td', {}, h('span', { class: `status ${st[1]}` }, st[0])),
            h('td', {}, st[1] === 'open' && h('button', {
              class: 'btn small danger', type: 'button',
              onclick: async () => { if (confirm(`Void the voucher ending ${v.hint}? It can no longer be redeemed.`)) { await api('/api/admin/vouchers/void', { id: v.id }); load(); } },
            }, 'Void')),
          );
        })),
      ));
    }

    const amount = h('input', { type: 'number', min: '1', step: '0.01', value: '50', inputmode: 'decimal', 'aria-label': 'Amount per voucher' });
    const count = h('input', { type: 'number', min: '1', max: '500', step: '1', value: '10', inputmode: 'numeric', 'aria-label': 'How many vouchers' });
    const note = h('input', { type: 'text', maxlength: '100', placeholder: 'e.g. Launch giveaway (optional)', 'aria-label': 'Note' });
    const msg = h('p', { class: 'msg' });
    const go = h('button', { class: 'btn', type: 'submit' }, 'Create vouchers');

    root.replaceChildren(
      h('div', { class: 'topbar' },
        h('div', { class: 'brand' }, h('span', { class: 'mark' }), 'Voucher admin'),
        h('button', { class: 'linkbtn', type: 'button', onclick: () => { store.clear(); login(); } }, 'Lock'),
      ),
      tiles,
      h('form', {
        class: 'card', novalidate: true,
        onsubmit: async (e) => {
          e.preventDefault();
          setMsg(msg, '');
          go.disabled = true;
          try {
            const r = await api('/api/admin/vouchers', { amount: amount.value, count: count.value, note: note.value });
            result.replaceChildren(
              h('p', { class: 'msg ok' }, `Created ${r.codes.length} voucher(s) of ${money(r.amount)}. These codes are shown only now, so save them.`),
              h('pre', { class: 'codes' }, r.codes.join('\n')),
              h('div', { class: 'actions' },
                h('button', { class: 'btn small', type: 'button', onclick: (ev) => { navigator.clipboard.writeText(r.codes.join('\n')).then(() => { ev.currentTarget.textContent = 'Copied'; }); } }, 'Copy all'),
                h('button', { class: 'btn small ghost', type: 'button', onclick: () => downloadCsv(r.codes, r.amount, r.batch) }, 'Download CSV'),
              ),
            );
            await load();
          } catch (ex) {
            setMsg(msg, ex.message, 'err');
          } finally { go.disabled = false; }
        },
      },
        h('h2', {}, 'Create vouchers'),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', {}, `Amount each (${cur})`), amount),
          h('label', { class: 'field' }, h('span', {}, 'How many'), count),
        ),
        h('label', { class: 'field' }, h('span', {}, 'Note'), note),
        msg, go,
      ),
      result,
      h('div', { class: 'card' }, h('h2', {}, 'Recent vouchers'), listWrap, h('p', { class: 'hint' }, 'For safety the full codes are never stored, only a hash and the last four characters.')),
    );

    try { await load(); } catch (ex) { if (ex.status === 401) { store.clear(); login('Admin key rejected.'); } }
  }

  (async () => {
    try { const c = await (await fetch('/api/config')).json(); cur = c.currency || 'R'; } catch { /* default */ }
    if (!store.get()) return login();
    try { await api('/api/admin/summary'); dashboard(); } catch (ex) { store.clear(); login(ex.status === 401 ? '' : ex.message); }
  })();
})();
