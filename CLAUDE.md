# 99 имён Аллаха — Асма-уль-Хусна

## Текущее состояние проекта

**Версия:** 28.0.0  
**Репозиторий:** renatmag18-debug/99-imen-allaha  
**Рабочая ветка:** claude/not-updating-vdrruf  

## Структура проекта

```
├── index.html              # Основная веб-страница приложения
├── cloudflare-worker.js    # Cloudflare Worker для обработки запросов
├── _headers               # Конфигурация заголовков для Cloudflare Pages
├── package.json           # Конфигурация Node.js проекта
├── _redirects             # Редиректы (если есть)
├── app/
│   └── build/outputs/apk/ # Сборка Android APK
└── manifest.json          # PWA манифест
```

## Текущая задача

Работа над веб-приложением и Android APK v28. Все изменения должны быть внесены в ветку `claude/not-updating-vdrruf`.

## Что нужно сделать

1. **Если нужна сборка APK:**
   - Проверить версию в `app/build.gradle` (текущая: versionCode 28, versionName "28.0")
   - Убедиться, что все источники скопированы
   - Запустить сборку через gradle

2. **Если нужны изменения в веб-части:**
   - Изменить `index.html` для обновления UI
   - Обновить `cloudflare-worker.js` если требуются изменения в логике
   - Проверить конфигурацию в `_headers`

3. **При завершении работы:**
   - Все изменения коммитить в ветку `claude/not-updating-vdrruf`
   - Использовать git push -u origin claude/not-updating-vdrruf
   - НЕ создавать PR без явного запроса

## Важные файлы

- **package.json** — конфигурация проекта (версия 28.0.0, type: commonjs)
- **app/build.gradle** — конфигурация Android-сборки (compileSdkVersion 36, targetSdkVersion 36)
- **_headers** — заголовки для APK файлов (Content-Type, Cache-Control)
- **cloudflare-worker.js** — логика обработки запросов на сервере

## Инструкции для новой сессии

1. Проверить статус: `git status`
2. Убедиться, что находитесь в ветке: `git branch`
3. Выполнить необходимые изменения в указанной ветке
4. Коммитить и пушить в `claude/not-updating-vdrruf`
5. Если требуется сборка APK — использовать gradle в директории `99ism-android`
