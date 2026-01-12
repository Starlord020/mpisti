const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

let rooms = {};

function broadcastRoomList() {
  let list = [];
  for (let key in rooms) {
    let r = rooms[key];
    list.push({
      id: r.id,
      count: r.players.length,
      status: r.gameStarted ? "Oynanıyor" : "Bekliyor",
    });
  }
  io.emit("roomList", list);
}

io.on("connection", (socket) => {
  broadcastRoomList();

  // SES İLETİMİ
  socket.on("voice", (data) => {
    if (data.roomId && data.blob) {
      socket.to(data.roomId).emit("voice", data.blob);
    }
  });

  socket.on("speaking", (data) => {
    if (data.roomId) {
      socket.to(data.roomId).emit("playerSpeaking", {
        id: socket.id,
        isSpeaking: data.isSpeaking,
      });
    }
  });

  socket.on("createRoom", (data) => {
    let roomId = data.roomId;
    let username = data.username;
    if (rooms[roomId]) {
      socket.emit("errorMsg", "Bu isimde bir masa zaten var!");
    } else {
      rooms[roomId] = {
        id: roomId,
        players: [],
        deck: [],
        centerPile: [],
        teamAPile: [],
        teamBPile: [],
        totalScoreA: 0,
        totalScoreB: 0,
        targetScore: 151,
        gameStarted: false,
        turnIndex: 0,
        roundStarterIndex: 0,
        admin: socket.id,
        lastWinnerTeam: null,
      };
      joinRoom(socket, roomId, username);
    }
  });

  socket.on("setTarget", (data) => {
    let room = rooms[data.roomId];
    if (room && room.admin === socket.id && !room.gameStarted) {
      room.targetScore = parseInt(data.target);
      io.to(room.id).emit("updateTarget", room.targetScore);
    }
  });

  socket.on("joinRoom", (data) => {
    let roomId = data.roomId;
    if (!rooms[roomId]) socket.emit("errorMsg", "Masa bulunamadı.");
    else joinRoom(socket, roomId, data.username);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));

  socket.on("addBot", (roomId) => {
    let room = rooms[roomId];
    if (!room || room.players.length >= 4 || room.gameStarted) return;
    addBotToRoom(room);
    io.to(roomId).emit("updateRoom", room);
    broadcastRoomList();
  });

  socket.on("startGame", (roomId) => {
    let room = rooms[roomId];
    if (!room || room.admin !== socket.id || room.gameStarted) return;

    // Eksik oyuncuları botlarla tamamla
    let playerCount = room.players.length;
    if (playerCount < 2) {
      addBotToRoom(room);
    } else if (playerCount === 3) {
      addBotToRoom(room);
    }

    room.gameStarted = true;
    room.totalScoreA = 0;
    room.totalScoreB = 0;
    room.roundStarterIndex = 0;
    room.turnIndex = 0;
    startRound(room, true);
    broadcastRoomList();
  });

  socket.on("playCard", (data) => {
    let room = rooms[data.roomId];
    if (!room || !room.gameStarted) return;
    if (room.players[room.turnIndex].id !== socket.id) return;
    let player = room.players.find((p) => p.id === socket.id);
    processMove(room, player, data.cardIndex);
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

// --- YARDIMCI FONKSİYONLAR ---

function addBotToRoom(room) {
  let botId = "BOT_" + Date.now() + "_" + Math.floor(Math.random() * 100);
  room.players.push({
    id: botId,
    name: "Bot " + (room.players.length + 1),
    isBot: true,
    hand: [],
  });
}

function processMove(room, player, cardIndex) {
  if (!player.hand[cardIndex]) return;
  let playedCard = player.hand.splice(cardIndex, 1)[0];
  let playerIndex = room.players.findIndex((p) => p.id === player.id);
  let currentTeam = playerIndex % 2 === 0 ? "A" : "B";

  room.centerPile.push(playedCard);
  io.to(room.id).emit("updateGame", room);

  let captured = false;
  if (room.centerPile.length >= 2) {
    let prevCard = room.centerPile[room.centerPile.length - 2];
    if (playedCard.value === prevCard.value || playedCard.value === "J") {
      captured = true;
      if (room.centerPile.length === 2 && playedCard.value === prevCard.value)
        playedCard.isPisti = true;
    }
  }

  if (captured) {
    setTimeout(() => {
      if (currentTeam === "A") room.teamAPile.push(...room.centerPile);
      else room.teamBPile.push(...room.centerPile);
      room.centerPile = [];
      room.lastWinnerTeam = currentTeam;
      finishTurn(room);
    }, 1000);
  } else {
    finishTurn(room);
  }
}

function finishTurn(room) {
  let allHandsEmpty = room.players.every((p) => p.hand.length === 0);
  if (allHandsEmpty) {
    if (room.deck.length > 0) {
      dealCards(room);
      room.turnIndex = (room.turnIndex + 1) % room.players.length;
      io.to(room.id).emit("updateGame", { ...room, isDealAnim: true });
      checkBotTurn(room);
    } else calculateRoundEnd(room);
  } else {
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    io.to(room.id).emit("updateGame", room);
    checkBotTurn(room);
  }
}

function startRound(room, isFirstGame = false) {
  if (!isFirstGame) {
    room.roundStarterIndex = (room.roundStarterIndex + 1) % room.players.length;
    room.turnIndex = room.roundStarterIndex;
  }
  room.teamAPile = [];
  room.teamBPile = [];
  room.centerPile = [];
  room.lastWinnerTeam = null;
  createDeck(room);
  for (let i = 0; i < 4; i++) room.centerPile.push(room.deck.pop());
  dealCards(room);
  io.to(room.id).emit("gameStarted", room);
  io.to(room.id).emit("updateScores", {
    scoreA: room.totalScoreA,
    scoreB: room.totalScoreB,
    target: room.targetScore,
  });
  checkBotTurn(room);
}

function leaveRoom(socket) {
  let roomId = null;
  for (let key in rooms) {
    if (rooms[key].players.find((p) => p.id === socket.id)) {
      roomId = key;
      break;
    }
  }
  if (roomId) {
    let room = rooms[roomId];
    room.players = room.players.filter((p) => p.id !== socket.id);
    socket.leave(roomId);
    if (!room.gameStarted && room.players.length === 0) {
      delete rooms[roomId];
    } else if (room.players.length > 0) {
      if (room.admin === socket.id && room.players[0] && !room.players[0].isBot)
        room.admin = room.players[0].id;
      io.to(roomId).emit("updateRoom", room);
      if (room.gameStarted && !room.players.some((p) => !p.isBot))
        delete rooms[roomId];
    }
    broadcastRoomList();
  }
}

function joinRoom(socket, roomId, username) {
  let room = rooms[roomId];
  if (room.players.find((p) => p.id === socket.id)) return;
  if (room.players.length < 4 && !room.gameStarted) {
    socket.join(roomId);
    room.players.push({
      id: socket.id,
      name: username,
      isBot: false,
      hand: [],
    });
    socket.emit("joined", {
      roomId: roomId,
      isAdmin: room.admin === socket.id,
      myIndex: room.players.length - 1,
      target: room.targetScore,
    });
    io.to(roomId).emit("updateRoom", room);
    broadcastRoomList();
  } else socket.emit("errorMsg", "Masa dolu veya oyun başlamış!");
}

function calculateRoundEnd(room) {
  if (room.lastWinnerTeam) {
    if (room.lastWinnerTeam === "A") room.teamAPile.push(...room.centerPile);
    else room.teamBPile.push(...room.centerPile);
    room.centerPile = [];
  }
  let roundA = calculateTotalScore(room.teamAPile);
  let roundB = calculateTotalScore(room.teamBPile);
  if (room.teamAPile.length > room.teamBPile.length) roundA += 3;
  else if (room.teamBPile.length > room.teamAPile.length) roundB += 3;
  room.totalScoreA += roundA;
  room.totalScoreB += roundB;

  let target = room.targetScore || 151;
  if (room.totalScoreA >= target || room.totalScoreB >= target) endMatch(room);
  else {
    io.to(room.id).emit("roundOver", {
      roundA: roundA,
      roundB: roundB,
      totalA: room.totalScoreA,
      totalB: room.totalScoreB,
    });
    setTimeout(() => {
      startRound(room, false);
    }, 3000);
  }
}

function checkBotTurn(room) {
  let currentPlayer = room.players[room.turnIndex];
  if (currentPlayer && currentPlayer.isBot && room.gameStarted) {
    setTimeout(() => {
      botPlay(room, currentPlayer);
    }, 1200);
  }
}

function botPlay(room, bot) {
  if (!room.gameStarted || bot.hand.length === 0) return;
  let moveIndex = 0;
  if (room.centerPile.length > 0) {
    let topCard = room.centerPile[room.centerPile.length - 1];
    let matchIndex = bot.hand.findIndex((c) => c.value === topCard.value);
    if (matchIndex !== -1) moveIndex = matchIndex;
    else {
      let jackIndex = bot.hand.findIndex((c) => c.value === "J");
      if (jackIndex !== -1) moveIndex = jackIndex;
      else moveIndex = Math.floor(Math.random() * bot.hand.length);
    }
  } else moveIndex = Math.floor(Math.random() * bot.hand.length);
  processMove(room, bot, moveIndex);
}

function createDeck(room) {
  const suits = ["♥", "♦", "♣", "♠"];
  const values = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
    "A",
  ];
  room.deck = [];
  for (let s of suits)
    for (let v of values) room.deck.push({ suit: s, value: v });
  room.deck.sort(() => Math.random() - 0.5);
}

function dealCards(room) {
  room.players.forEach((p) => {
    p.hand = [];
    for (let i = 0; i < 4; i++)
      if (room.deck.length > 0) p.hand.push(room.deck.pop());
  });
}

function calculateTotalScore(pile) {
  let score = 0;
  pile.forEach((card) => {
    if (card.isPisti) score += card.value === "J" ? 20 : 10;
    else {
      if (card.value === "A" || card.value === "J") score += 1;
      if (card.suit === "♦" && card.value === "10") score += 3;
      if (card.suit === "♣" && card.value === "2") score += 2;
    }
  });
  return score;
}

function endMatch(room) {
  let teamAName = "",
    teamBName = "";
  if (room.players[0]) teamAName += room.players[0].name;
  if (room.players[2]) teamAName += " & " + room.players[2].name;
  if (room.players[1]) teamBName += room.players[1].name;
  if (room.players[3]) teamBName += " & " + room.players[3].name;
  let winnerName = room.totalScoreA > room.totalScoreB ? teamAName : teamBName;
  io.to(room.id).emit("matchOver", {
    scoreA: room.totalScoreA,
    scoreB: room.totalScoreB,
    winner: winnerName,
    teamAName: teamAName,
    teamBName: teamBName,
  });
  room.gameStarted = false;
}

// RENDER.COM İÇİN DİNAMİK PORT AYARI
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Sunucu ${PORT} portunda aktif!`));
