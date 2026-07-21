const dictionaries = {
  ru: {
    appName: 'Instagram Hunter', candidates: 'Кандидаты', bloggers: 'Блогеры', reels: 'Рилсы', queue: 'Очередь', settings: 'Настройки',
    login: 'Войти', username: 'Логин', password: 'Пароль', logout: 'Выйти', add: 'Добавить', process: 'Обработать', approve: 'Одобрить', reject: 'Отклонить',
    archive: 'Архивировать', restore: 'Восстановить', refresh: 'Обновить', search: 'Поиск', loadMore: 'Показать ещё', noData: 'Пока нет данных',
    'auth.invalid': 'Неверный логин или пароль'
  },
  en: {
    appName: 'Instagram Hunter', candidates: 'Candidates', bloggers: 'Bloggers', reels: 'Reels', queue: 'Queue', settings: 'Settings',
    login: 'Sign in', username: 'Username', password: 'Password', logout: 'Sign out', add: 'Add', process: 'Process', approve: 'Approve', reject: 'Reject',
    archive: 'Archive', restore: 'Restore', refresh: 'Refresh', search: 'Search', loadMore: 'Load more', noData: 'No data yet',
    'auth.invalid': 'Invalid username or password'
  }
};

export function i18nMiddleware(req, res, next) {
  const cookieLocale = req.headers.cookie?.match(/(?:^|; )locale=(ru|en)/)?.[1];
  const browserLocale = req.acceptsLanguages('ru', 'en') || 'en';
  req.locale = selectLocale({ sessionLocale: req.session?.locale, cookieLocale, browserLocale });
  req.t = (key) => dictionaries[req.locale]?.[key] || dictionaries.en[key] || key;
  res.locals.locale = req.locale;
  res.locals.t = req.t;
  next();
}

export function selectLocale({ sessionLocale, cookieLocale, browserLocale }) {
  for (const value of [sessionLocale, cookieLocale, browserLocale]) if (value === 'ru' || value === 'en') return value;
  return 'en';
}
