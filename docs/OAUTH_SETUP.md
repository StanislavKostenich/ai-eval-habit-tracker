# OAuth Setup Guide

This app supports Google and GitHub login. Follow these steps to set up OAuth credentials.

## Google OAuth Setup

1. **Go to Google Cloud Console**
   - Visit https://console.cloud.google.com/
   - Sign in with your Google account

2. **Create a new project**
   - Click the project dropdown at the top
   - Click "New Project"
   - Name it "Habit Tracker" and create

3. **Enable Google+ API**
   - In the left sidebar, go to "APIs & Services" → "Enabled APIs & services"
   - Click "Enable APIs and Services"
   - Search for "Google+ API"
   - Click it and press "Enable"

4. **Create OAuth 2.0 credentials**
   - Go to "APIs & Services" → "Credentials"
   - Click "Create Credentials" → "OAuth 2.0 Client ID"
   - Application type: "Web application"
   - Add authorized redirect URIs:
     - `http://localhost:3000/api/auth/google/callback`
   - Click Create

5. **Copy your credentials**
   - Copy `Client ID` → `GOOGLE_CLIENT_ID` in `.env`
   - Copy `Client Secret` → `GOOGLE_CLIENT_SECRET` in `.env`

## GitHub OAuth Setup

1. **Go to GitHub Settings**
   - Visit https://github.com/settings/developers
   - Click "OAuth Apps" (or "New OAuth App")

2. **Create a new OAuth App**
   - Application name: "Habit Tracker"
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/api/auth/github/callback`
   - Click "Register application"

3. **Copy your credentials**
   - Copy `Client ID` → `GITHUB_CLIENT_ID` in `.env`
   - Click "Generate a new client secret" and copy it → `GITHUB_CLIENT_SECRET` in `.env`

## Update .env File

```bash
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GITHUB_CLIENT_ID=your_github_client_id_here
GITHUB_CLIENT_SECRET=your_github_client_secret_here
SESSION_SECRET=generate_a_random_32_char_string_here
DATABASE_PATH=./data/habits.db
PORT=3000
FRONTEND_URL=http://localhost:5173
```

**Important:** Never commit `.env` to git. It's already in `.gitignore`.

## Generate SESSION_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Copy the output and use it for `SESSION_SECRET`.

## Testing OAuth

1. Start the app: `npm run dev`
2. Go to http://localhost:5173/login
3. Click "Continue with Google" or "Continue with GitHub"
4. You'll be redirected to the OAuth provider
5. Authorize the app
6. You'll be logged in and redirected to the dashboard

## Troubleshooting

### "Redirect URI mismatch" error
- Make sure the callback URL in your OAuth app matches exactly
- For local development: `http://localhost:3000/api/auth/google/callback`

### "Invalid Client" error
- Verify your Client ID and Secret are correct
- Check they're in the `.env` file (not `.env.example`)
- Restart the app after changing `.env`

### Session issues
- The app stores sessions in `./data/sessions.db`
- If you have issues, delete this file and restart
- Sessions persist across restarts with the SQLite store
