document.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-drawer]')) document.querySelector('#drawer').innerHTML = '';
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
document.body.addEventListener('htmx:afterSwap', (event) => localizeTimes(event.detail.target));
