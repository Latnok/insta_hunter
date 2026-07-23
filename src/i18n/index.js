const dictionaries = {
  ru: {
    appName: 'Instagram Hunter', candidates: 'Кандидаты', bloggers: 'Блогеры', content: 'Контент', reels: 'Контент', queue: 'Задачи', settings: 'Настройки', system: 'Система',
    login: 'Войти', username: 'Логин', password: 'Пароль', logout: 'Выйти', add: 'Добавить', process: 'Запустить анализ', approve: 'Одобрить', reject: 'Отклонить',
    archive: 'Перенести в архив', restore: 'Восстановить', refresh: 'Обновить данные', search: 'Найти', loadMore: 'Показать ещё', noData: 'Пока нет данных', close: 'Закрыть',
    'nav.primary': 'Основная навигация', 'nav.system': 'Системные разделы', 'nav.language': 'Переключить язык',
    'auth.invalid': 'Неверный логин или пароль', 'error.notFound': 'Страница не найдена', 'error.internal': 'Произошла внутренняя ошибка', 'notice.saved': 'Готово. Изменения сохранены.',
    'status.candidate': 'Кандидат', 'status.approved': 'Одобрен', 'status.rejected': 'Отклонён', 'status.archived': 'В архиве',
    'status.pending': 'Ожидает', 'status.running': 'Выполняется', 'status.retry_wait': 'Повторная попытка', 'status.succeeded': 'Готово', 'status.failed': 'Ошибка', 'status.cancelled': 'Отменено', 'status.available': 'Готово', 'status.unavailable': 'Недоступно', 'status.empty': 'Нет текста', 'status.error': 'Ошибка',
    'status.draft': 'Черновик', 'status.active': 'Активна', 'status.superseded': 'Предыдущая',
    'quality.useful': 'Полезный', 'quality.noise': 'Шум', 'quality.low_value': 'Мало пользы', 'quality.empty': 'Нет текста', 'quality.unclassified': 'Не определено',
    'recommendation.approve': 'Рекомендует одобрить', 'recommendation.reject': 'Рекомендует отклонить', 'recommendation.needs_manual_review': 'Нужна ручная проверка', 'recommendation.insufficient_data': 'Недостаточно данных',
    'job.discover_accounts': 'Поиск аккаунтов', 'job.fetch_profile': 'Загрузка профиля', 'job.fetch_reels': 'Загрузка контента', 'job.fetch_transcript': 'Получение расшифровки', 'job.classify_transcript': 'Проверка расшифровки', 'job.evaluate_candidate': 'Оценка кандидата', 'job.propose_criteria': 'Обновление критериев', 'job.draft_outreach': 'Подготовка сообщения',
    'metric.followers': 'Подписчики', 'metric.reels': 'Материалы', 'metric.useful': 'Полезные', 'metric.plays': 'Просмотры', 'metric.likes': 'Лайки', 'metric.comments': 'Комментарии'
  },
  en: {
    appName: 'Instagram Hunter', candidates: 'Candidates', bloggers: 'Bloggers', content: 'Content', reels: 'Content', queue: 'Tasks', settings: 'Settings', system: 'System',
    login: 'Sign in', username: 'Username', password: 'Password', logout: 'Sign out', add: 'Add', process: 'Run analysis', approve: 'Approve', reject: 'Reject',
    archive: 'Move to archive', restore: 'Restore', refresh: 'Refresh data', search: 'Search', loadMore: 'Load more', noData: 'No data yet', close: 'Close',
    'nav.primary': 'Primary navigation', 'nav.system': 'System sections', 'nav.language': 'Switch language',
    'auth.invalid': 'Invalid username or password', 'error.notFound': 'Page not found', 'error.internal': 'An internal error occurred', 'notice.saved': 'Done. Your changes were saved.',
    'status.candidate': 'Candidate', 'status.approved': 'Approved', 'status.rejected': 'Rejected', 'status.archived': 'Archived',
    'status.pending': 'Waiting', 'status.running': 'In progress', 'status.retry_wait': 'Retry scheduled', 'status.succeeded': 'Completed', 'status.failed': 'Failed', 'status.cancelled': 'Cancelled', 'status.available': 'Ready', 'status.unavailable': 'Unavailable', 'status.empty': 'No text', 'status.error': 'Error',
    'status.draft': 'Draft', 'status.active': 'Active', 'status.superseded': 'Previous',
    'quality.useful': 'Useful', 'quality.noise': 'Noise', 'quality.low_value': 'Low value', 'quality.empty': 'No text', 'quality.unclassified': 'Unclassified',
    'recommendation.approve': 'Recommends approval', 'recommendation.reject': 'Recommends rejection', 'recommendation.needs_manual_review': 'Manual review needed', 'recommendation.insufficient_data': 'Not enough data',
    'job.discover_accounts': 'Account search', 'job.fetch_profile': 'Profile fetch', 'job.fetch_reels': 'Content fetch', 'job.fetch_transcript': 'Transcript fetch', 'job.classify_transcript': 'Transcript review', 'job.evaluate_candidate': 'Candidate evaluation', 'job.propose_criteria': 'Criteria update', 'job.draft_outreach': 'Message preparation',
    'metric.followers': 'Followers', 'metric.reels': 'Content', 'metric.useful': 'Useful', 'metric.plays': 'Plays', 'metric.likes': 'Likes', 'metric.comments': 'Comments'
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
