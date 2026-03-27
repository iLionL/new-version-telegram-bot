# Telegram Polling Bot

A small Node.js Telegram bot with todo notes, reminders, and weather lookup.

## Requirements

- Node.js `18+`
- Telegram bot token
- OpenWeather API key

## Installation

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

```env
TELEGRAM_TOKEN=your_telegram_token
WEATHER_API_KEY=your_openweather_api_key
```

## Local Run

```bash
npm run dev
```

Or without auto-restart:

```bash
npm start
```

## Production Run

```bash
npm install --omit=dev
npm start
```
