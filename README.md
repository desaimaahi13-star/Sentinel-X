# Sentinel-X

This repository contains the backend for the Sentinel-X SOC dashboard.

## Local Setup

```bash
# clone repository (if not already on disk)
# git clone https://github.com/<your-username>/sentinel-x.git
cd sentinel-x
npm install
npm start   # runs server on http://localhost:3000
```

## Configuration

- Add an optional `.env` or `config.json` containing `VIRUSTOTAL_API_KEY`.
- The app will create `data.db` on first run; do not commit it.

## Deploying to GitHub

1. Initialize git: `git init`.
2. Add files: `git add .`.
3. Commit: `git commit -m "initial commit"`.
4. Create a GitHub repo and add remote: `git remote add origin https://github.com/<your-username>/sentinel-x.git`.
5. Push to `main`: `git push -u origin main`.

Replace `<your-username>` with your GitHub handle.

## Running tests

Currently, no automated tests are defined.
