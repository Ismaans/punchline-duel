# Winner Screen Answer Cycle

## Summary

On the game-over winner screen, cycle through the best and worst answers of the game, so players can relive the highlights while the winner music plays instead of looking at a static screen.

## Current Behavior

- When the final round ends, the game moves to `GAME_OVER`. That phase has no timer: the screen stays up until the host presses a button.
- The host screen (`gameOverScreen` in `public/host.js`) shows:
  - "And the winner is…" (or "It's a tie!") with the winner's avatar, name and score.
  - The final standings list.
  - "Play Again (same players)" and "New Game" buttons.
  - Confetti, the procedural win sound, and the winner fanfare followed by the winner music loop.
- Phones (`gameOverScreen` in `public/play.js`) show only your rank and score.
- Nothing moves after the first few seconds of confetti.
- No answers appear. The server's game-over view (`view.gameOver` in `server/game.js`) contains only `standings`. Round 1 and 2 matchups are thrown away when the next round starts (`state.round = null`), so by game over only the final round's results still exist.

## Proposed Behavior

- **Keep a history.** The server keeps every Round 1 and Round 2 matchup result and the final-round results for the whole game: prompt, both answers, authors, vote counts, and the result type (normal, Clean Sweep, Mind Meld, forfeit).
- **Pick highlights at game over:**
  - **Best answers:** Clean Sweeps first, then the highest vote share.
  - **Worst answers:** answers that got 0 votes, or the lowest vote share.
  - A few of each, around 3–5, without showing one player too many times.
  - Skip missing answers (`[no answer]`) and Mind Melds.
- **Show them on the host screen.** Next to the champion and standings, a highlight card cycles automatically every ~5 seconds. Each card shows the prompt, the answer, its author, its votes, and a label like "Best of the night" or "Tough crowd". It loops until the host presses Play Again or New Game.
- The winner, standings and buttons stay visible the whole time.
- Answer authors are only revealed at game over, so nothing leaks earlier.
- Phones are unchanged.

## Acceptance Criteria

- [ ] The game-over host screen cycles through highlight cards from all three rounds, a few seconds per card, looping until Play Again or New Game.
- [ ] The cards include both "best" and "worst" answers, each with its prompt, author and vote count.
- [ ] Missing answers and Mind Melds are never shown as highlights.
- [ ] If a game has too few answers, the screen shows whatever exists, or just today's static screen, without errors.
- [ ] Winner music, confetti, standings and the Play Again / New Game buttons work as they do today.
- [ ] The history is cleared for each new game (Play Again or New Game).
- [ ] Unit tests in `test/game.test.js` cover picking the highlights.
