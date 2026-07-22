document.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-drawer]')) document.querySelector('#drawer').innerHTML = '';
  const suggestion = event.target.closest('[data-discovery-query]');
  if (suggestion) {
    const input = document.querySelector('#discovery-query');
    if (input) {
      input.value = suggestion.dataset.discoveryQuery;
      input.focus();
    }
  }
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
function applyDiscoveryQuery(root = document) {
  const suggestion = root.querySelector?.('[data-discovery-query-default]');
  const input = document.querySelector('#discovery-query');
  if (suggestion && input) input.value = suggestion.dataset.discoveryQueryDefault;
}
document.addEventListener('DOMContentLoaded', () => { localizeTimes(); applyDiscoveryQuery(); });
document.body.addEventListener('htmx:afterSwap', (event) => {
  localizeTimes(event.detail.target);
  applyDiscoveryQuery(event.detail.target);
});
document.body.addEventListener('htmx:configRequest', (event) => {
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  if (token) event.detail.headers['X-CSRF-Token'] = token;
});
