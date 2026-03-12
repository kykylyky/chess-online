const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// ─── STATIC FILE SERVER ───────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public',
    req.url === '/' ? 'index.html' : req.url);

  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css'
  };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── ROOM MANAGEMENT ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const rooms = {}; // roomId -> { players: [{ws, color}], gameState: {...} }

// ─── INITIAL GAME STATE (server's authoritative copy) ─────────────────────────
function createInitialState() {
  return {
    whitePawns:      [[0,1],[1,1],[2,1],[3,1],[4,1],[5,1],[6,1],[7,1]],
    blackPawns:      [[0,6],[1,6],[2,6],[3,6],[4,6],[5,6],[6,6],[7,6]],
    whiteRooks:      [[0,0],[7,0]],
    blackRooks:      [[0,7],[7,7]],
    whiteKnights:    [[1,0],[6,0]],
    blackKnights:    [[1,7],[6,7]],
    whiteBishops:    [[2,0],[5,0]],
    blackBishops:    [[2,7],[5,7]],
    whiteQueen:      [3,0],
    blackQueen:      [3,7],
    whiteKing:       [4,0],
    blackKing:       [4,7],
    whiteKingMoved:  false,
    blackKingMoved:  false,
    whiteRookLMoved: false,
    whiteRookRMoved: false,
    blackRookLMoved: false,
    blackRookRMoved: false,
    whiteTurn:       true,
    capturedPieces:  [],
    activeCards:     [],
    turnNumber:      0
  };
}

// ─── CAPTURE LOGIC ────────────────────────────────────────────────────────────
// Called after a move is validated.
// Checks every enemy piece — if it shares the destination square, mark it dead.
// Returns a description of what was captured (or null) for the log.
function processCapturesOnServer(state, toX, toY, movingPlayerColor) {
  const enemyColor = 1 - movingPlayerColor;
  let captured = null;

  // Helper: check an array of pieces and set matching one to [-1,-1]
  function checkArray(arr, typeName) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i][0] === toX && arr[i][1] === toY) {
        console.log(`[Capture] ${typeName} ${i} (color ${enemyColor}) captured at (${toX},${toY})`);
        arr[i] = [-1, -1];
        captured = { type: typeName, index: i, color: enemyColor };
        return true;
      }
    }
    return false;
  }

  if (enemyColor === 0) {
    // Enemy is white — check all white pieces
    if (!checkArray(state.whitePawns,   'pawn'))
    if (!checkArray(state.whiteRooks,   'rook'))
    if (!checkArray(state.whiteKnights, 'knight'))
    if (!checkArray(state.whiteBishops, 'bishop')) {
      if (state.whiteQueen[0] === toX && state.whiteQueen[1] === toY) {
        console.log(`[Capture] Queen (white) captured at (${toX},${toY})`);
        state.whiteQueen = [-1, -1];
        captured = { type: 'queen', index: 0, color: 0 };
      } else if (state.whiteKing[0] === toX && state.whiteKing[1] === toY) {
        console.log(`[Capture] King (white) captured — GAME OVER`);
        state.whiteKing = [-1, -1];
        captured = { type: 'king', index: 0, color: 0 };
      }
    }
  } else {
    // Enemy is black — check all black pieces
    if (!checkArray(state.blackPawns,   'pawn'))
    if (!checkArray(state.blackRooks,   'rook'))
    if (!checkArray(state.blackKnights, 'knight'))
    if (!checkArray(state.blackBishops, 'bishop')) {
      if (state.blackQueen[0] === toX && state.blackQueen[1] === toY) {
        console.log(`[Capture] Queen (black) captured at (${toX},${toY})`);
        state.blackQueen = [-1, -1];
        captured = { type: 'queen', index: 0, color: 1 };
      } else if (state.blackKing[0] === toX && state.blackKing[1] === toY) {
        console.log(`[Capture] King (black) captured — GAME OVER`);
        state.blackKing = [-1, -1];
        captured = { type: 'king', index: 0, color: 1 };
      }
    }
  }

  if (captured) {
    state.capturedPieces.push(captured);
  }

  return captured;
}

// ─── MOVE APPLICATION ─────────────────────────────────────────────────────────
// Moves the piece on the server's authoritative state.
// Returns false if the move is illegal (wrong turn, piece not found).
function applyMoveOnServer(state, move) {
  const { pieceType, pieceIndex, playerColor, toX, toY } = move;

  // Basic turn check
  if ((state.whiteTurn && playerColor !== 0) ||
      (!state.whiteTurn && playerColor !== 1)) {
    console.warn('[Move rejected] Wrong turn');
    return false;
  }

  // Bounds check
  if (toX < 0 || toX > 7 || toY < 0 || toY > 7) {
    console.warn('[Move rejected] Out of bounds');
    return false;
  }

  // Apply the move to the correct piece array
  if (pieceType === 0) {
    const arr = playerColor === 0 ? state.whitePawns : state.blackPawns;
    if (!arr[pieceIndex] || arr[pieceIndex][0] === -1) return false;
    arr[pieceIndex] = [toX, toY];
  } else if (pieceType === 1) {
    const arr = playerColor === 0 ? state.whiteKnights : state.blackKnights;
    if (!arr[pieceIndex] || arr[pieceIndex][0] === -1) return false;
    arr[pieceIndex] = [toX, toY];
  } else if (pieceType === 2) {
    const arr = playerColor === 0 ? state.whiteBishops : state.blackBishops;
    if (!arr[pieceIndex] || arr[pieceIndex][0] === -1) return false;
    arr[pieceIndex] = [toX, toY];
  } else if (pieceType === 3) {
    const arr = playerColor === 0 ? state.whiteRooks : state.blackRooks;
    if (!arr[pieceIndex] || arr[pieceIndex][0] === -1) return false;
    arr[pieceIndex] = [toX, toY];
    // Track rook movement for castling
    if (playerColor === 0) {
      if (pieceIndex === 0) state.whiteRookLMoved = true;
      else                  state.whiteRookRMoved = true;
    } else {
      if (pieceIndex === 0) state.blackRookLMoved = true;
      else                  state.blackRookRMoved = true;
    }
  } else if (pieceType === 4) {
    const queen = playerColor === 0 ? state.whiteQueen : state.blackQueen;
    if (queen[0] === -1) return false;
    if (playerColor === 0) state.whiteQueen = [toX, toY];
    else                   state.blackQueen = [toX, toY];
  } else if (pieceType === 5) {
    const king = playerColor === 0 ? state.whiteKing : state.blackKing;
    if (king[0] === -1) return false;
    if (playerColor === 0) { state.whiteKing = [toX, toY]; state.whiteKingMoved = true; }
    else                   { state.blackKing = [toX, toY]; state.blackKingMoved = true; }
  } else {
    console.warn('[Move rejected] Unknown piece type:', pieceType);
    return false;
  }

  // Process captures AFTER moving (so the moving piece's new position is set)
  const captured = processCapturesOnServer(state, toX, toY, playerColor);

  // Advance turn and tick cards
  state.whiteTurn = !state.whiteTurn;
  state.turnNumber++;
  tickActiveCardsOnServer(state);

  return true;
}

// ─── CARD SYSTEM HOOKS (server-side, future-ready) ───────────────────────────
function applyCardOnServer(state, card) {
  // Add to active cards if multi-turn
  if (card.turnsRemaining > 1) {
    state.activeCards.push({ ...card, turnsUsed: 0 });
  }

  // Future card effects go here:
  // switch (card.cardId) {
  //   case 'double_move':   ... break;
  //   case 'freeze_piece':  ... break;
  //   case 'swap_pieces':   ... break;
  //   case 'extra_pawn':    ... break;
  // }
}

function tickActiveCardsOnServer(state) {
  state.activeCards = state.activeCards
    .map(c => ({ ...c, turnsUsed: c.turnsUsed + 1 }))
    .filter(c => c.turnsUsed < c.turnsRemaining);
}

// ─── WEBSOCKET HANDLER ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerRoom  = null;
  let playerColor = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { console.warn('Bad JSON from client'); return; }

    // ── JOIN ──────────────────────────────────────────────────────────────────
    if (msg.type === 'join') {
      const roomId = msg.roomId || 'default';

      if (!rooms[roomId]) {
        rooms[roomId] = { players: [], gameState: createInitialState() };
      }
      const room = rooms[roomId];

      if (room.players.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
        return;
      }

      playerColor = room.players.length; // 0 = white, 1 = black
      playerRoom  = roomId;
      room.players.push({ ws, color: playerColor });

      ws.send(JSON.stringify({
        type:   'assigned',
        color:  playerColor,
        roomId
      }));

      if (room.players.length === 2) {
        // Both players ready — send start + initial state to each
        room.players.forEach(p => p.ws.send(JSON.stringify({
          type:      'start',
          gameState: room.gameState
        })));
        console.log(`[Room ${roomId}] Game started`);
      }
      return;
    }

    if (!playerRoom || !rooms[playerRoom]) return;
    const room = rooms[playerRoom];

    // ── MOVE ──────────────────────────────────────────────────────────────────
    if (msg.type === 'move') {
      const ok = applyMoveOnServer(room.gameState, msg.move);
      if (!ok) {
        ws.send(JSON.stringify({ type: 'error', message: 'Illegal move rejected' }));
        return;
      }

      // Broadcast the authoritative post-capture state to BOTH players
      const broadcast = JSON.stringify({
        type:      'state_update',
        gameState: room.gameState,
        move:      msg.move,
        timestamp: Date.now()
      });
      room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(broadcast);
      });

      // Check for game over (king captured)
      const wk = room.gameState.whiteKing;
      const bk = room.gameState.blackKing;
      if (wk[0] === -1 || bk[0] === -1) {
        const winner = wk[0] === -1 ? 'Black' : 'White';
        const endMsg = JSON.stringify({ type: 'game_over', winner });
        room.players.forEach(p => {
          if (p.ws.readyState === WebSocket.OPEN) p.ws.send(endMsg);
        });
        console.log(`[Room ${playerRoom}] Game over — ${winner} wins`);
        delete rooms[playerRoom];
      }
      return;
    }

    // ── CARD ──────────────────────────────────────────────────────────────────
    if (msg.type === 'card') {
      applyCardOnServer(room.gameState, msg.card);

      const broadcast = JSON.stringify({
        type:      'state_update',
        gameState: room.gameState,
        card:      msg.card,
        timestamp: Date.now()
      });
      room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(broadcast);
      });
      return;
    }

    // ── SYNC REQUEST (e.g. on reconnect) ─────────────────────────────────────
    if (msg.type === 'sync_request') {
      ws.send(JSON.stringify({
        type:      'state_update',
        gameState: room.gameState
      }));
      return;
    }
  });

  // ── DISCONNECT ───────────────────────────────────────────────────────────
  ws.on('close', () => {
    if (playerRoom && rooms[playerRoom]) {
      rooms[playerRoom].players = rooms[playerRoom].players.filter(p => p.ws !== ws);
      rooms[playerRoom].players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) {
          p.ws.send(JSON.stringify({ type: 'opponent_disconnected' }));
        }
      });
      if (rooms[playerRoom].players.length === 0) {
        delete rooms[playerRoom];
        console.log(`[Room ${playerRoom}] Closed`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Chess server running at http://localhost:${PORT}`);
});