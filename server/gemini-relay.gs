// Посредник СКАМ → Gemini (Google Apps Script, с 0.4.2).
// Google не пускает в Gemini API запросы из России, а сервер СКАМ стоит в Москве. Этот скрипт
// работает на серверах Google и просто передаёт запрос дальше: функция bot-ai шлёт ему
// { key, path, body } (POST) и получает { status, body } — код и тело ответа Gemini.
// Ключ хранится не здесь, а в базе СКАМ (private.bot_ai_settings.api_key) и приходит в запросе.
//
// Как поставить: script.google.com → «Новый проект» → вставить этот код → сохранить →
// «Начать развертывание» → «Новое развертывание» → «Веб-приложение»: «Запуск от имени» — Я,
// «У кого есть доступ» — Все → разрешить доступ. Адрес веб-приложения (…/exec) записать в базу:
//   update private.bot_ai_settings set relay_url = 'https://script.google.com/macros/s/…/exec' where id;
// Изменили код — «Управление развертываниями» → карандаш → «Новая версия» (адрес не меняется).

var BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/';

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var path = String(req.path || 'chat/completions');
    if (!/^[a-z0-9\/._-]+$/i.test(path)) return out(400, '{"error":{"message":"bad path"}}');
    var opt = { method: req.method === 'get' ? 'get' : 'post',
                headers: { Authorization: 'Bearer ' + req.key }, muteHttpExceptions: true };
    if (opt.method === 'post') { opt.contentType = 'application/json'; opt.payload = JSON.stringify(req.body || {}); }
    var res = UrlFetchApp.fetch(BASE + path, opt);
    return out(res.getResponseCode(), res.getContentText());
  } catch (err) {
    return out(502, JSON.stringify({ error: { message: String(err) } }));
  }
}

function doGet() { return out(200, '{"ok":"skam-relay"}'); }

function out(status, body) {
  return ContentService.createTextOutput(JSON.stringify({ status: status, body: body }))
    .setMimeType(ContentService.MimeType.JSON);
}
