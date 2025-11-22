# Talky – Node.js Demo (GitHub-backed storage)

This is a **demo Node.js server** for a FaceTime-style calling & messaging web app UI called **Talky**.

- Serves a modern web UI from `/public`
- Stores all chat data in **a JSON file inside a GitHub repo**
- Uses the **GitHub REST “contents” API** to `GET` and `PUT` `talky/data.json`

> ⚠️ This is not production-grade security or scaling. It's a demo for layout + GitHub-backed persistence.

---

## 1. Requirements

- **Node.js 18+** (for built-in `fetch`)
- A GitHub repo where the server can read/write a JSON file
- A **GitHub personal access token (PAT)** with permission to update that repo (classic token with `repo` scope, or fine-grained token with `contents:read/write`).

Official GitHub docs for the contents API: see "Create or update file contents" and `PUT /repos/{owner}/{repo}/contents/{path}`.  

---

## 2. Setup

```bash
git clone YOUR_REPO_WITH_THIS_CODE
cd talky-node

# install dependencies
npm install
```

Configure environment variables:

1. Copy `.env.example` to `.env` (if using something like `dotenv` or host dashboard env vars).
2. Set:

```bash
GITHUB_TOKEN=ghp_your_token_here
GITHUB_OWNER=your-github-username-or-org
GITHUB_REPO=your-data-repo-name
GITHUB_BRANCH=main
DATA_PATH=talky/data.json
PORT=3000
```

The first time the server runs, if `DATA_PATH` doesn't exist in that repo, it will create an initial JSON file with a couple of sample chats + messages.

---

## 3. Run locally

```bash
npm start
```

Then open:

- http://localhost:3000

You’ll see:

- Top row: **Video Call** and **Audio Call** buttons (UI only, no WebRTC).
- Underneath: **Messages** section with chat list on the left and iMessage-style bubbles on the right.

---

## 4. API

### `GET /api/data`

Returns the whole JSON blob from `talky/data.json` (or whatever `DATA_PATH` you configured):

```jsonc
{
  "version": 1,
  "createdAt": "2025-11-21T10:00:00.000Z",
  "chats": [
    { "id": 1, "name": "Alex Johnson", "time": "9:12 AM", "presence": "Online • Available" },
    { "id": 2, "name": "Family Group", "time": "Yesterday", "presence": "3 members • Notifications on" }
  ],
  "messages": {
    "1": [ { "from": "them", "text": "Hey!", "ts": 1732192800000 } ],
    "2": [ { "from": "me", "text": "Hi fam", "ts": 1732192810000 } ]
  }
}
```

### `POST /api/message`

Append a message to a chat and persist it to GitHub.

**Body:**

```json
{
  "chatId": 1,
  "from": "me",
  "text": "Hello from Talky"
}
```

- `chatId` – numeric or string id matching a `chat.id`
- `from` – `"me"` or `"them"` (UI uses this to style bubble side)
- `text` – message text

The server:

1. Loads the current JSON file from GitHub.
2. Pushes the new message into `messages[chatId]` (creates the array if needed).
3. Bumps the `time` for that chat so the list shows a recent time.
4. PUTs the updated file back to GitHub with a commit message like `"Add message in chat 1"`.

If the GitHub file changed between your read and write, you might get a **409 conflict**.

---

## 5. Front-end behavior

The `public` folder contains:

- `index.html` – page shell
- `styles.css` – Apple-ish styling
- `app.js` – front-end logic

On load, the front-end:

1. `GET /api/data` to grab initial chats + messages.
2. Renders chat list and message bubbles.
3. When you send a message from the UI, it calls `POST /api/message` and updates the view.

Auth / “paid site” behavior in this demo is **client-side only** – no real billing or user database yet.

---

## 6. Deploying

You can run this on any Node-capable platform (Render, Railway, Fly.io, etc.).

- Set the same env vars (`GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, `DATA_PATH`).
- Expose port `3000` or whatever your platform expects.
- Point your domain (e.g. `talky.yourdomain.com`) to the app.

For serious production use you would also:

- Move authentication to the server (sessions/JWT, OAuth, etc.).
- Use a proper database instead of a single JSON file in GitHub.
- Implement rate limiting and stronger validation.

For now, this is a **clean demo** that does exactly what you asked: Node.js server + GitHub-backed JSON storage.
