# Punchline Duel

A real-time party game for 3–8 players. Everyone's phone is a controller; one shared
screen (a laptop on a TV, a projector...) is the "host" that shows the game.

1. **Round 1:** every player gets two fill-in-the-blank prompts. Each prompt goes to
   exactly two players, who duel head-to-head.
2. Everyone else votes for the funnier answer. Points are split by vote share
   (Round 1 is worth 1,000 per matchup; get every vote for a **Clean Sweep** bonus).
3. **Round 2:** same thing, double points.
4. **Final round:** one prompt for everybody. Each player gets 3 votes to spread or
   stack on other people's answers (300 points per vote).
5. Highest score wins. Play again with the same crew or start fresh.

Built with Node.js, Express and Socket.IO. The front end is plain HTML/CSS/JavaScript
modules with no build step.

---

## Run it on your computer

You need **Node.js 20 or newer** (`node --version` to check).

```bash
npm install      # once, downloads Express and Socket.IO
npm start        # starts the server on http://localhost:3000
```

While you're editing code, `npm run dev` restarts the server whenever a `.js` file
changes. (It doesn't watch `server/prompts.json`; restart by hand after editing prompts.)

Then:

- **Host screen:** open <http://localhost:3000/host> on the laptop / TV.
- **Players:** open <http://localhost:3000/> and type the 4-letter room code.

Want to test a whole game quickly? Use <http://localhost:3000/host?fast=1>. Every
timer runs 5x faster.

To use a different port: `PORT=4000 npm start`.

### Playing with real phones on the same Wi-Fi

Phones can't use `localhost` (that means "this phone"), so they need your laptop's
address on the local network.

1. Start the server. The terminal prints something like
   `Phones (same Wi-Fi): http://192.168.1.23:3000/`. The host screen shows the same
   address and the QR code points to it.
   - You can also find the address yourself: on a Mac run `ipconfig getifaddr en0`;
     on Windows run `ipconfig` and look for "IPv4 Address".
2. Make sure the phones are on the **same Wi-Fi network** as the laptop (not on
   cellular data, and not on a "guest" network that blocks devices from seeing each other).
3. On the phone, scan the QR code on the host screen, or type the address into the browser.
4. If the phone can't connect: on a Mac, when you first run `npm start` you may get a
   popup "Do you want the application node to accept incoming network connections?".
   Click **Allow**. (If you missed it: System Settings → Network → Firewall → Options,
   and allow `node`.) School/work Wi-Fi often blocks this completely; a phone hotspot
   or home Wi-Fi works.

---

## Testing tools

### Unit tests

```bash
npm test
```

These test the game rules in `server/game.js`: prompt assignment, scoring, Mind Melds,
forfeits, final-round voting, phase order, and that answer authors never leak to players
during voting.

### Bots (fake players)

Don't have 3 friends handy? Open a host screen, note the room code, then in a
second terminal:

```bash
npm run bots -- ABCD 4          # 4 bots join room ABCD
npm run bots -- ABCD 4 --lazy   # bots sometimes "forget" to answer or vote
npm run bots -- NEW 5           # no browser at all: makes its own fast room, plays a full game, prints the results
```

The `--` is how npm passes arguments to the script. Bots answer with silly canned
text, vote randomly, and rejoin automatically if their connection drops. You can join
from your own phone too and play alongside them. Press `Ctrl+C` to remove them.

To point bots at a deployed server: `npm run bots -- ABCD 4 --url https://your-app.onrender.com`.

### Health check

<http://localhost:3000/health> returns `ok`. Render uses this to know the server is up.

---

## Deploy to Render (free), step by step

[Render](https://render.com) runs Node servers and supports WebSockets on the free plan.

### 1. Put the code on GitHub

1. Create a free account at <https://github.com> if you don't have one.
2. Click **+ → New repository**. Name it `punchline-duel`, leave it empty (don't add a
   README or .gitignore), and click **Create repository**.
3. In a terminal in this project folder:

   ```bash
   git init
   git add .
   git commit -m "Punchline Duel"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/punchline-duel.git
   git push -u origin main
   ```

   (Replace `YOUR-USERNAME`. If git asks for a password, GitHub needs a
   [personal access token](https://github.com/settings/tokens) instead of your
   account password, or use GitHub Desktop.)
   `node_modules` is left out on purpose by `.gitignore`; Render installs it itself.

### 2. Create the web service on Render

1. Sign up at <https://render.com> (signing in with GitHub is easiest).
2. Click **New + → Web Service**, then pick your `punchline-duel` repository
   (click "Configure account" to give Render access if it isn't listed).
3. Fill in:

   | Setting | Value |
   | --- | --- |
   | Language / Runtime | Node |
   | Branch | `main` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | Free |

4. Open **Advanced** and set **Health Check Path** to `/health`.
   You don't need to set `PORT`; Render provides it and the server reads it.
5. Click **Create Web Service**. The first build takes a couple of minutes. When the
   log says `Punchline Duel server running on port …` and the status turns
   **Live**, your game is at
   `https://punchline-duel-xxxx.onrender.com`.
6. Open `https://…onrender.com/host` on the big screen; players go to the main URL
   (the QR code on the host screen points there automatically).

Every `git push` to `main` redeploys automatically.

(Alternatively, the included `render.yaml` lets you use **New + → Blueprint** and skip
the form above.)

### Free-plan things to know

- **It falls asleep.** After ~15 minutes with no visitors the server shuts down; the
  next visit takes 30–60 seconds to wake it. Open the host page a minute before game time.
- **Rooms live in memory.** If the server restarts or sleeps, open rooms are gone.
  (There's no database; that's by design for a party game.)
- One server instance only. Don't scale it up to multiple instances or players in the
  same room could end up on different servers.

---

## How the code is organized

```
server/
  index.js      Express + Socket.IO: rooms, reconnects, validation, timers, logs
  game.js       ALL game rules as pure functions (no sockets, no timers), unit tested
  rooms.js      Room codes, tokens, cleanup of idle rooms
  timers.js     One phase timer per room
  prompts.json  Built-in prompts ("final": true ones are used for the final round)
public/
  play.html/js/css   Phone controller (served at /)
  host.html/js/css   Big screen (served at /host)
  audio/             Background music (MP3s), played only on the big screen
  shared/            Code used by both pages (and some by the server):
                     event names, constants, DOM helpers, sounds, confetti
scripts/bots.js      Fake players for testing
test/                node:test unit tests
```

The server is the only source of truth. Phones send things like "my answer is X" or
"I vote for the left one"; the server checks them, updates the game, and sends every
screen its own filtered view of the game (players never receive who wrote what until
the reveal). All socket event names live in `public/shared/events.js`.

To add prompts, edit `server/prompts.json`. Each needs a unique `id`, the `text`
(use `_____` for the blank), and `"final": true` or `false`. Hosts can also type
custom prompts into the lobby before a game; those are used first.

`server/prompts-quiplash.json` holds round 1/2 prompts imported from Jackbox's
Quiplash games (© Jackbox Games). It's built by `node scripts/import-quiplash-prompts.js`.
Set `QUIPLASH_PROMPTS=off` to leave them out, or delete the file to remove them.
