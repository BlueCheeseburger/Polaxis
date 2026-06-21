# Polaxis

A 2D political compass that maps your beliefs onto economic and social axes using AI analysis. Describe your views in text or take a 20-question quiz, get a political archetype and party alignment breakdown, save and share your result, and debate live with other users — either against an AI adversary or matched with a real opponent via WebSocket.

## Features

- **Text & quiz modes** — free-form belief input analyzed by Gemini AI, or a scored 20-question quiz with instant results
- **Political archetype** — a punchy 2–3 word identity specific to your placement (e.g. "The Pragmatist")
- **Party affinity** — percentage alignment with Democrat, Republican, Libertarian, and Green parties
- **Reference overlays** — plot your position against global leaders, U.S. party figures, ideologies, or personality traits
- **Multi-point support** — contradictory beliefs split into 2–4 points with individual analysis
- **Refinement mode** — targeted follow-up questions to sharpen your placement
- **Share links** — shareable URLs with OG embeds for Discord, iMessage, and Reddit
- **Share images** — generated 1080×1500px cards with your archetype, compass, and party bars
- **Comparison mode** — load a friend's result alongside yours on the same canvas
- **AI debate** — argue against a dynamically generated adversary based on your placement
- **Peer debate** — real-time 1v1 debates with matched opponents via Socket.IO

## Stack

- **Frontend:** React 19, Vite, Canvas API
- **Backend:** Express 5, Node.js
- **AI:** Google Gemini API
- **Database:** Supabase (PostgreSQL)
- **Real-time:** Socket.IO
- **Mobile:** Capacitor (Android)

## Setup

```bash
npm install
```

Create a `.env` file in the root:

```
GEMINI_API_KEY=your_key
SUPABASE_URL=your_url
SUPABASE_SERVICE_ROLE_KEY=your_key
RESEND_API_KEY=your_key
FEEDBACK_TO_EMAIL=your_email
```

```bash
# Run frontend
npm run dev

# Run backend
npm run server
```
