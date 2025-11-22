# Talky – GitHub-backed Storage Version

This is a Node.js + Express app for **Talky** that stores all data
(users, chats, messages) in a **JSON file inside a GitHub repo** using
the GitHub Contents API.

- Full-screen Apple-like layout
- Login / Sign up with salted SHA-256 password hashes
- Cookie sessions
- Per-user chats + messages written to `DATA_PATH` in your repo
- Admin secret menu (Ctrl + Alt + Shift + Z on login screen)
  - Admin password from `ADMIN_PASSWORD`
  - List users, delete users (+ their chats/messages)

## Setup

1. Create a GitHub **personal access token** with permission to update the repo
   you want to use for storage.

2. Copy `.env.example` to `.env` and set:

   - `GITHUB_TOKEN`
   - `GITHUB_OWNER`
   - `GITHUB_REPO`
   - `GITHUB_BRANCH`
   - `DATA_PATH`
   - `ADMIN_PASSWORD`
   - `SESSION_SECRET`
   - `PORT`

3. Install & run:

```bash
npm install
npm start
```

Open http://localhost:3000
