# Collabra

A real-time collaborative whiteboard app where teams can draw, design, and brainstorm together.

## Features

- **Real-time collaboration** — multiple users on the same canvas via Socket.io
- **Google Sign-In** — authenticate with your Google account
- **Google Drive integration** — auto-sync projects as SVG files to your Drive
- **Drawing tools** — rectangle, ellipse, diamond, line, brush, text, and image uploads
- **Undo/redo** — Ctrl+Z / Ctrl+Shift+Z per file
- **Multi-page projects** — add and switch between pages/files within a project
- **Export** — download canvas as SVG or entire project as a ZIP of SVGs
- **Project templates** — Blank, Poster Starter, Social Media Pack
- **Role-based access** — owner, editor, and viewer roles
- **Member management** — invite users by email, assign and change roles

## Editing Lock System

Only one person can edit a file at a time. An editor must **acquire the lock** before making any changes. Everyone else sees the canvas in view-only mode and gets a toast notification when someone starts or finishes editing. If the lock holder disconnects, the lock is automatically released and their changes are saved.

## Tech Stack

| Layer     | Technology                                    |
| --------- | --------------------------------------------- |
| Backend   | Node.js, Express, Socket.io                   |
| Frontend  | React, Vite                                   |
| Canvas    | Fabric.js (SVG rendering)                     |
| Database  | PostgreSQL (shapes stored as JSONB)           |
| Auth      | Google OAuth 2.1 + email/password             |
| Sync      | Google Drive API (mirrors projects as SVGs)   |

## Getting Started

### Prerequisites

- Node.js
- A PostgreSQL database
- Google OAuth credentials (for sign-in and Drive sync)

### Backend

1. Navigate to the `backend` directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with the following variables:
   ```env
   DATABASE_URL=postgresql://user:password@localhost:5432/collabra
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_DRIVE_CLIENT_ID=your-drive-client-id
   GOOGLE_DRIVE_CLIENT_SECRET=your-drive-client-secret
   GOOGLE_DRIVE_REDIRECT_URI=http://localhost:5173/integrations/google-drive/callback
   ```

4. Start the server:
   ```bash
   npm run dev
   ```

### Frontend

1. Navigate to the `frontend` directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file:
   ```env
   VITE_API_BASE=http://localhost:3000
   ```

4. Start the dev server:
   ```bash
   npm run dev
   ```

5. Open the URL shown in the terminal in your browser.

## Project Structure

```
Collabra/
├── backend/
│   ├── index.js        # Express server, Socket.io, REST API, Drive sync
│   └── db.js           # PostgreSQL connection
├── frontend/
│   └── src/
│       ├── App.jsx         # App router (Auth → Dashboard → Editor)
│       ├── AuthScreen.jsx  # Login / signup / Google sign-in
│       ├── Dashboard.jsx   # Project list and creation
│       ├── Editor.jsx      # Whiteboard editor with lock system
│       ├── Canvas.jsx      # Fabric.js canvas wrapper
│       ├── MembersModal.jsx # Member management UI
│       └── socket.js       # Socket.io client setup
└── readme.md
```
