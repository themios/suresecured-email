'use strict';

// ─── Lucide SVG icons (18×18, stroke="currentColor") ─────────────────────────
const ICONS = {
  // Sidebar nav
  dashboard: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>`,
  analytics:  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>`,
  leads:      `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  sequences:  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  admin:      `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  settings:   `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  logout:     `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>`,

  // KPI metric icons (20×20)
  users:       `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  mouseclick:  `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 9 5 12 1.8-5.2L21 14Z"/><path d="M7.2 2.2 8 5.1"/><path d="m5.1 8-2.9-.8"/><path d="M14 4.1 12 6"/><path d="m6 12-1.9 2"/></svg>`,
  dollar:      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
  award:       `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/></svg>`,
  phone:       `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.83 12 19.79 19.79 0 0 1 1.8 3.44 2 2 0 0 1 3.74 1.5H6.7a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  clipboard:   `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`,
  shoppingbag: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" x2="21" y1="6" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
  eyeoff:      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>`,
  msgcircle:   `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`,
  flame:       `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,

  // Activity timeline icons (14×14)
  send:        `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`,
  inbox:       `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
  msgsquare:   `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  phonesm:     `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.83 12 19.79 19.79 0 0 1 1.8 3.44 2 2 0 0 1 3.74 1.5H6.7a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`,
  pencil:      `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`,
  playsm:      `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  ban:         `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>`,
  warning:     `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  check:       `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`,
  x:           `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  arrowleft:   `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`,
  plus:        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`,
  search:      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  chevronright:`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`,
};

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Sidebar nav ──────────────────────────────────────────────────────────────
function sidebar(activePage, user) {
  const NAV = [
    { page: 'dashboard', label: 'Overview',   href: '/dashboard',  icon: ICONS.dashboard },
    { page: 'analytics', label: 'Analytics',  href: '/analytics',  icon: ICONS.analytics },
    { page: 'leads',     label: 'Leads',      href: '/leads',      icon: ICONS.leads },
    { page: 'sequences', label: 'Sequences',  href: '/sequences',  icon: ICONS.sequences },
    { page: 'admin',     label: 'Admin',      href: '/admin',      icon: ICONS.admin },
    { page: 'settings',  label: 'Settings',   href: '/settings',   icon: ICONS.settings },
  ];

  const userInitial = (user?.name || user?.email || 'A')[0].toUpperCase();
  const userName    = user?.name || user?.email || 'Admin';
  const userRole    = user?.role || 'admin';

  return `
  <aside style="width:220px;min-width:220px;flex-shrink:0" class="bg-slate-900 min-h-screen flex flex-col sticky top-0 h-screen overflow-y-auto z-30">
    <div class="px-5 pt-5 pb-4 border-b border-slate-800">
      <div class="font-bold text-white text-sm tracking-tight leading-none">SureSecured</div>
      <div class="text-slate-500 text-xs mt-1 font-medium">SalesPilot AI</div>
    </div>

    <nav class="flex-1 px-3 py-4 space-y-0.5" role="navigation">
      ${NAV.map(item => `
      <a href="${item.href}"
         class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer ${
           activePage === item.page
             ? 'bg-blue-600 text-white shadow-sm'
             : 'text-slate-400 hover:text-white hover:bg-slate-800'
         }"
         ${activePage === item.page ? 'aria-current="page"' : ''}>
        ${item.icon}
        ${item.label}
      </a>`).join('')}
    </nav>

    <div class="px-3 pb-4 border-t border-slate-800 pt-3 mt-auto">
      <div class="flex items-center gap-2.5 px-3 py-2 mb-1">
        <div class="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 select-none">
          ${esc(userInitial)}
        </div>
        <div class="min-w-0">
          <div class="text-slate-300 text-xs font-semibold truncate">${esc(userName)}</div>
          <div class="text-slate-500 text-xs truncate capitalize">${esc(userRole)}</div>
        </div>
      </div>
      <a href="/logout"
         class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-white hover:bg-slate-800 transition-all duration-150 cursor-pointer">
        ${ICONS.logout}
        Sign out
      </a>
    </div>
  </aside>`;
}

// ─── Shared CSS + JS injected on every page ───────────────────────────────────
const SHARED_HEAD = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body, button, input, select, textarea { font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; }
    :root {
      --primary: #0369a1;
      --primary-dark: #0284c7;
      --sidebar: #0f172a;
      --bg: #f8fafc;
      --surface: #ffffff;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #64748b;
      --success: #059669;
      --danger: #dc2626;
      --warning: #d97706;
    }
    /* Toast */
    #_toast_box { position:fixed; bottom:1.5rem; right:1.5rem; z-index:9999; display:flex; flex-direction:column; gap:.5rem; pointer-events:none; }
    ._toast { display:flex; align-items:center; gap:.625rem; padding:.75rem 1rem; border-radius:.75rem; font-size:.875rem; font-weight:600; min-width:260px; max-width:380px; pointer-events:auto; animation:_toastIn .18s ease; color:#fff; box-shadow:0 4px 24px rgba(0,0,0,.18); }
    ._toast.success { background:#059669; }
    ._toast.error   { background:#dc2626; }
    ._toast.info    { background:#0369a1; }
    ._toast.warn    { background:#d97706; }
    @keyframes _toastIn { from { transform:translateY(6px); opacity:0; } to { transform:translateY(0); opacity:1; } }
    /* Confirm / Prompt modal */
    #_modal_overlay { position:fixed; inset:0; background:rgba(15,23,42,.5); z-index:9998; display:flex; align-items:center; justify-content:center; padding:1rem; backdrop-filter:blur(2px); }
    ._modal_box { background:#fff; border-radius:1rem; padding:1.5rem; max-width:420px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,.2); }
    ._modal_box h3 { font-size:1rem; font-weight:700; color:#0f172a; margin:0 0 .5rem; }
    ._modal_box p  { font-size:.875rem; color:#475569; margin:0 0 .25rem; line-height:1.5; }
    ._modal_box input { width:100%; border:1px solid #e2e8f0; border-radius:.5rem; padding:.5rem .75rem; font-size:.875rem; margin-top:.5rem; font-family:inherit; outline:none; }
    ._modal_box input:focus { border-color:#0369a1; box-shadow:0 0 0 3px rgba(3,105,161,.15); }
    ._modal_btns { display:flex; gap:.5rem; justify-content:flex-end; margin-top:1.25rem; }
    ._modal_btns button { padding:.5rem 1.25rem; border-radius:.5rem; font-size:.875rem; font-weight:600; cursor:pointer; border:none; transition:opacity .15s; font-family:inherit; }
    ._modal_btns button:hover { opacity:.88; }
    ._btn_cancel { background:#f1f5f9; color:#475569; }
    ._btn_ok     { background:#0369a1; color:#fff; }
    ._btn_danger { background:#dc2626; color:#fff; }
    /* Skeleton shimmer */
    @keyframes _shimmer { 0%{background-position:-600px 0} 100%{background-position:600px 0} }
    .skeleton { border-radius:.5rem; background:linear-gradient(90deg,#e2e8f0 25%,#f1f5f9 50%,#e2e8f0 75%); background-size:1200px 100%; animation:_shimmer 1.4s infinite; }
    /* Smooth table row hover */
    .data-table tr { transition:background .1s; }
    /* Focus ring */
    button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline:2px solid #0369a1; outline-offset:2px;
    }
    /* cursor on interactive rows */
    [onclick] { cursor:pointer; }
  </style>`;

const SHARED_JS = `
<div id="_toast_box"></div>
<div id="_modal_overlay" style="display:none">
  <div class="_modal_box">
    <h3 id="_modal_title">Confirm</h3>
    <p  id="_modal_msg"></p>
    <input type="text" id="_modal_input" style="display:none" autocomplete="off">
    <div class="_modal_btns">
      <button class="_btn_cancel" id="_modal_cancel">Cancel</button>
      <button class="_btn_ok"     id="_modal_ok">Confirm</button>
    </div>
  </div>
</div>
<script>
(function(){
  // ── Toast ────────────────────────────────────────────────────────────
  window.showToast = function(msg, type, ms) {
    type = type || 'info'; ms = ms || 4000;
    var box = document.getElementById('_toast_box');
    var el  = document.createElement('div');
    el.className = '_toast ' + type;
    el.innerHTML = msg;
    box.appendChild(el);
    setTimeout(function() {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function(){ el.remove(); }, 260);
    }, ms);
  };

  // ── Modal helpers ────────────────────────────────────────────────────
  var _resolve = null;

  function _openModal(title, msg, showInput, inputVal, okLabel, okClass) {
    document.getElementById('_modal_title').textContent  = title;
    document.getElementById('_modal_msg').textContent    = msg;
    var inp = document.getElementById('_modal_input');
    inp.style.display = showInput ? '' : 'none';
    inp.value = inputVal || '';
    var okBtn = document.getElementById('_modal_ok');
    okBtn.textContent = okLabel || 'Confirm';
    okBtn.className   = okClass  || '_btn_ok';
    document.getElementById('_modal_overlay').style.display = 'flex';
    if (showInput) { setTimeout(function(){ inp.focus(); inp.select(); }, 50); }
    return new Promise(function(res){ _resolve = res; });
  }

  document.getElementById('_modal_ok').addEventListener('click', function() {
    document.getElementById('_modal_overlay').style.display = 'none';
    if (_resolve) { _resolve(document.getElementById('_modal_input').style.display === 'none' ? true : document.getElementById('_modal_input').value); _resolve = null; }
  });
  document.getElementById('_modal_cancel').addEventListener('click', function() {
    document.getElementById('_modal_overlay').style.display = 'none';
    if (_resolve) { _resolve(null); _resolve = null; }
  });
  document.getElementById('_modal_input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  document.getElementById('_modal_ok').click();
    if (e.key === 'Escape') document.getElementById('_modal_cancel').click();
  });
  document.getElementById('_modal_overlay').addEventListener('click', function(e) {
    if (e.target === this) document.getElementById('_modal_cancel').click();
  });

  window.showConfirm  = function(msg, title)         { return _openModal(title||'Confirm', msg, false, '', 'Confirm', '_btn_ok'); };
  window.showDestruct = function(msg, title, label)  { return _openModal(title||'Are you sure?', msg, false, '', label||'Delete', '_btn_danger'); };
  window.showPrompt   = function(msg, def, title)    { return _openModal(title||'Enter a value', msg, true, def||'', 'OK', '_btn_ok'); };
})();
</script>`;

// ─── Full page shell ──────────────────────────────────────────────────────────
function shell(title, activePage, content, opts) {
  opts = opts || {};
  const user       = opts.user       || null;
  const extraHead  = opts.extraHead  || '';
  const scripts    = opts.scripts    || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} – SureSecured</title>
  ${SHARED_HEAD}
  ${extraHead}
</head>
<body class="bg-slate-50 min-h-screen">
  <div class="flex min-h-screen">
    ${sidebar(activePage, user)}
    <div class="flex-1 min-w-0 overflow-x-hidden">
      ${content}
    </div>
  </div>
  ${SHARED_JS}
  ${scripts}
</body>
</html>`;
}

// ─── Backward-compat navHtml for routes that still call it directly ───────────
// Returns just the sidebar HTML (wrapping layout is now done via shell()).
// Routes that haven't been migrated yet will still get the sidebar injected.
function navHtml(activePage, user) {
  // For legacy call sites that wrap with their own body/flex, return a
  // lightweight top bar so the page doesn't break while being migrated.
  return `<nav class="bg-slate-900 text-white px-6 py-3 flex items-center gap-6 shadow-md" style="font-family:'Plus Jakarta Sans',system-ui,sans-serif">
    <div>
      <span class="font-bold text-white text-sm">SureSecured</span>
      <span class="text-slate-500 text-xs ml-2">SalesPilot AI</span>
    </div>
    <div class="flex gap-1">
      ${[
        ['Overview',  '/dashboard',  'dashboard'],
        ['Analytics', '/analytics',  'analytics'],
        ['Leads',     '/leads',      'leads'],
        ['Sequences', '/sequences',  'sequences'],
        ['Admin',     '/admin',      'admin'],
        ['Settings',  '/settings',   'settings'],
      ].map(([label, href, page]) => `
      <a href="${href}" class="px-3 py-2 text-sm font-medium rounded-lg transition duration-150 ${
        activePage === page
          ? 'bg-blue-600 text-white'
          : 'text-slate-400 hover:text-white hover:bg-slate-800'
      }">${label}</a>`).join('')}
    </div>
    <a href="/logout" class="ml-auto text-sm text-slate-400 hover:text-red-400 transition duration-150">Sign out</a>
  </nav>`;
}

module.exports = { shell, sidebar, navHtml, esc, ICONS };
