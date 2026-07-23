let drawerTrigger = null;

function closeDrawer() {
  const drawer = document.querySelector('#drawer');
  if (!drawer?.innerHTML) return;
  drawer.innerHTML = '';
  document.querySelector('#drawer-backdrop').hidden = true;
  document.body.classList.remove('drawer-open');
  drawerTrigger?.focus();
  drawerTrigger = null;
}

document.addEventListener('click', (event) => {
  const opener = event.target.closest('[hx-target="#drawer"]');
  if (opener) drawerTrigger = opener;
  if (event.target.closest('[data-close-drawer]')) closeDrawer();
  if (event.target.closest('[data-dismiss-flash]')) event.target.closest('.flash')?.remove();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});
document.addEventListener('submit', (event) => {
  const message = event.target.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});
function localizeTimes(root = document) {
  root.querySelectorAll('time[data-utc]').forEach((element) => {
    const date = new Date(element.dataset.utc);
    if (!Number.isNaN(date.getTime())) element.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  });
}
document.addEventListener('DOMContentLoaded', () => localizeTimes());
document.body.addEventListener('htmx:afterSwap', (event) => {
  localizeTimes(event.detail.target);
  if (event.detail.target.id === 'drawer' && event.detail.target.innerHTML) {
    document.querySelector('#drawer-backdrop').hidden = false;
    document.body.classList.add('drawer-open');
    event.detail.target.querySelector('button, a, input, textarea, select')?.focus();
  }
});
document.body.addEventListener('htmx:configRequest', (event) => {
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  if (token) event.detail.headers['X-CSRF-Token'] = token;
});
