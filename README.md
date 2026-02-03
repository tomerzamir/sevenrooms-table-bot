# SevenRooms Table Bot

A Node.js bot that monitors a SevenRooms restaurant booking page for available reservations within a specified time window and sends push notifications via Pushover.

## Features

- 🔍 Monitors SevenRooms booking pages using Playwright
- 📡 Intercepts network responses to find availability data
- ⏰ Filters reservations by time window
- 📱 Sends push notifications via Pushover
- 🔄 Prevents duplicate notifications
- 🤖 Runs automatically every 5 minutes via GitHub Actions

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Install Playwright Browsers

```bash
npx playwright install chromium
```

### 3. Configure Environment Variables

Set the following environment variables:

- `BOOKING_URL` - The SevenRooms booking page URL
- `PARTY_SIZE` - Number of people in your party
- `DATE` - Desired reservation date (format: YYYY-MM-DD)
- `WINDOW_START` - Start of time window (format: HH:MM, 24-hour)
- `WINDOW_END` - End of time window (format: HH:MM, 24-hour)
- `PUSHOVER_USER_KEY` - Your Pushover user key
- `PUSHOVER_APP_TOKEN` - Your Pushover app token

### 4. GitHub Actions Setup

1. Go to your repository settings → Secrets and variables → Actions
2. Add the following secrets:
   - `BOOKING_URL`
   - `PARTY_SIZE`
   - `DATE`
   - `WINDOW_START`
   - `WINDOW_END`
   - `PUSHOVER_USER_KEY`
   - `PUSHOVER_APP_TOKEN`

### 5. Run Locally

```bash
node check.js
```

## How It Works

1. Launches headless Chromium browser
2. Loads the SevenRooms booking page
3. Intercepts network responses to find availability API calls
4. Extracts available reservation times from JSON responses
5. Filters times within your specified window
6. Sends Pushover notification for new available slots
7. Tracks notified times in `state.json` to prevent duplicates

## Notes

- The bot includes anti-bot measures (random delays)
- Failed page loads are retried once automatically
- State is persisted in `state.json` (not committed to git)
- The workflow runs every 5 minutes via GitHub Actions cron

## License

MIT
