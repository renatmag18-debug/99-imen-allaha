# Инструкции для новой Claude Code сессии

## Основная информация

**Репозиторий:** renatmag18-debug/99-imen-allaha  
**Рабочая ветка:** claude/not-updating-vdrruf  
**Версия проекта:** 28.0.0  
**Статус:** Активная разработка

## ЧТО НУЖНО СДЕЛАТЬ

### Шаг 1: Проверить текущее состояние
```bash
git status
git branch -v
```

### Шаг 2: Убедиться, что вы в правильной ветке
- Должны быть в ветке: `claude/not-updating-vdrruf`
- Если нет, выполните: `git checkout claude/not-updating-vdrruf`

### Шаг 3: Основные файлы для редактирования

**Веб-приложение:**
- `index.html` — главная страница
- `cloudflare-worker.js` — серверная логика
- `_headers` — конфигурация заголовков

**Android APK:**
- `app/build.gradle` — конфигурация сборки (versionCode: 28, versionName: "28.0")
- `package.json` — версия проекта (28.0.0)

### Шаг 4: При завершении работы

```bash
git add .
git commit -m "Описание изменений"
git push -u origin claude/not-updating-vdrruf
```

## ⚠️ ВАЖНО

- **НЕ** создавайте PR без явного запроса
- **НЕ** пушьте в main или другие ветки
- Все изменения должны быть в `claude/not-updating-vdrruf`
- Проверяйте `git status` перед коммитом

## Последний коммит

- **Дата:** 08 августа 2026
- **Автор:** Claude
- **Сообщение:** Add CLAUDE.md with session instructions and project state
- **Хеш:** 27a1cee

## Нужна помощь?

Если потеряетесь, выполните:
```bash
git log --oneline -10  # Посмотреть историю
git diff HEAD~1       # Посмотреть последние изменения
```
