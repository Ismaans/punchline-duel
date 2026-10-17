/**
 * Socket event names — the single source of truth.
 *
 * This file is imported by BOTH the Node server (server/index.js) and the
 * browser (host.js, play.js). Because it's a plain ES module with no
 * dependencies, it works in both places unchanged.
 *
 * Using constants instead of typing strings like 'player:join' everywhere
 * means a typo becomes an obvious `undefined` instead of a silent bug
 * where an event is sent but nobody is listening.
 *
 * ---------------------------------------------------------------------------
 * CLIENT → SERVER
 * ---------------------------------------------------------------------------
 *  host:create        {}                          Host screen asks for a new room.
 *  host:rejoin        { roomCode, hostToken }     Host screen reconnects after refresh.
 *  host:start         {}                          Host presses "Start Game".
 *  host:kick          { playerId }                Host removes a player (lobby only).
 *  host:playAgain     { samePlayers: boolean }    After game over.
 *  host:addPrompt     { text }                    Custom prompt typed in the lobby.
 *  host:removePrompt  { promptId }                Delete a custom prompt (lobby only).
 *
 *  player:join        { roomCode, name }          Phone joins a room.
 *  player:rejoin      { roomCode, playerToken }   Phone reconnects after refresh.
 *  player:setAvatar   { avatar }                  Change emoji avatar (lobby only).
 *  player:start       {}                          VIP presses "Start Game".
 *  player:answer      { promptId, text }          Submit an answer (max 80 chars).
 *  player:vote        { matchupId, choice }       Vote in rounds 1/2 (choice: 0 or 1).
 *  player:finalVote   { answerIds: string[] }     Final round: exactly 3 votes.
 *  player:leave       {}                          Leave the room (frees the name in the lobby).
 *
 *  debug:ping         (ack callback)              Connectivity check / latency probe.
 *
 * ---------------------------------------------------------------------------
 * SERVER → CLIENT
 * ---------------------------------------------------------------------------
 *  room:state         { ...sanitized state }      Full state for THAT client only.
 *  game:error         { message }                 Friendly error to show the user.
 *                                                 (Not plain "error": in Node, an
 *                                                 EventEmitter "error" event with no
 *                                                 listener crashes the process.)
 *
 * Every client→server event accepts an optional "ack" callback, which is
 * Socket.IO's way of letting the server reply directly to one specific emit.
 * The reply is always { ok: true, ...data } or { ok: false, error, code? }.
 * If no ack callback is given, failures arrive as a game:error event instead.
 *
 * game:error codes the clients react to:
 *   ROOM_NOT_FOUND, REJOIN_FAILED, REMOVED (kicked), ROOM_CLOSED,
 *   REPLACED (same player opened in another tab), RATE_LIMITED
 */

export const EVENTS = Object.freeze({
  // Client → Server (host screen)
  HOST_CREATE: 'host:create',
  HOST_REJOIN: 'host:rejoin',
  HOST_START: 'host:start',
  HOST_KICK: 'host:kick',
  HOST_PLAY_AGAIN: 'host:playAgain',
  HOST_ADD_PROMPT: 'host:addPrompt',
  HOST_REMOVE_PROMPT: 'host:removePrompt',

  // Client → Server (phones)
  PLAYER_JOIN: 'player:join',
  PLAYER_REJOIN: 'player:rejoin',
  PLAYER_SET_AVATAR: 'player:setAvatar',
  PLAYER_START: 'player:start',
  PLAYER_ANSWER: 'player:answer',
  PLAYER_VOTE: 'player:vote',
  PLAYER_FINAL_VOTE: 'player:finalVote',
  PLAYER_LEAVE: 'player:leave',

  // Server → Client
  ROOM_STATE: 'room:state',
  ERROR: 'game:error',

  // Dev / diagnostics
  PING: 'debug:ping',
});
