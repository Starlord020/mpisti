const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: { origin: "*" },
    pingInterval: 10000,
    pingTimeout: 5000
});

app.use(express.static("public"));

let rooms = {};

// ODA LİSTESİNİ HERKESE GÖNDER
function broadcastRoomList() {
    let list = [];
    for (let key in rooms) {
        let r = rooms[key];
        list.push({
            id: r.id,
            count: r.players.length,
            status: r.gameStarted ? "Oynanıyor" : "Bekliyor"
        });
    }
    io.emit("roomList", list);
}

io.on("connection", (socket) => {
  broadcastRoomList();

  // --- SESLİ SOHBET (SADECE ODA İÇİ) ---
  socket.on("voice", (data) => {
      // Veriyi gönderen kişinin odasını bul
      let room = rooms[data.roomId];
      if (room && room.players.find(p => p.id === socket.id)) {
          // Sadece o odadakilere (gönderen hariç) ilet
          socket.to(data.roomId).emit("voice", data.blob);
      }
  });

  socket.on("speaking", (data) => {
      let room = rooms[data.roomId];
      if (room) {
          // Konuşuyor efektini odaya yay
          socket.to(data.roomId).emit("playerSpeaking", { 
              id: socket.id, 
              isSpeaking: data.isSpeaking 
          });
      }
  });

  // --- OYUN YÖNETİMİ ---
  socket.on("createRoom", (data) => {
    let roomId = data.roomId;
    if (rooms[roomId]) {
      socket.emit("errorMsg", "Bu isimde bir masa zaten var!");
    } else {
      rooms[roomId] = {
        id: roomId, players: [], deck: [], centerPile: [], teamAPile: [], teamBPile: [],
        totalScoreA: 0, totalScoreB: 0, targetScore: 151,
        gameStarted: false, turnIndex: 0, roundStarterIndex: 0, admin: socket.id, lastWinnerTeam: null 
      };
      joinRoom(socket, roomId, data.username);
    }
  });

  socket.on("joinRoom", (data) => {
      if (!rooms[data.roomId]) socket.emit("errorMsg", "Masa bulunamadı.");
      else joinRoom(socket, data.roomId, data.username);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));

  socket.on("startGame", (roomId) => {
    let room = rooms[roomId];
    if (!room || room.admin !== socket.id || room.gameStarted) return;
    
    // Eksik oyuncuları botla tamamla
    let count = room.players.length;
    if (count < 2) addBotToRoom(room);
    else if (count === 3) addBotToRoom(room);

    room.gameStarted = true; room.totalScoreA = 0; room.totalScoreB = 0;
    room.roundStarterIndex = 0; room.turnIndex = 0;
    startRound(room, true); 
    broadcastRoomList();
  });

  socket.on("addBot", (roomId) => {
    let room = rooms[roomId];
    if (room && !room.gameStarted && room.players.length < 4) {
        addBotToRoom(room);
        io.to(roomId).emit("updateRoom", room);
        broadcastRoomList();
    }
  });

  socket.on("playCard", (data) => {
      let room = rooms[data.roomId];
      if(!room || !room.gameStarted) return;
      if(room.players[room.turnIndex].id !== socket.id) return;
      processMove(room, room.players[room.turnIndex], data.cardIndex);
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

// YARDIMCI FONKSİYONLAR
function addBotToRoom(room) {
    let botId = "BOT_" + Date.now() + Math.floor(Math.random()*100);
    room.players.push({ id: botId, name: "Bot " + (room.players.length+1), isBot: true, hand: [] });
}

function joinRoom(socket, roomId, username) {
    let room = rooms[roomId];
    if(room.players.find(p => p.id === socket.id)) return;
    if (room.players.length < 4 && !room.gameStarted) {
      socket.join(roomId);
      room.players.push({ id: socket.id, name: username, isBot: false, hand: [] });
      socket.emit("joined", { roomId: roomId, isAdmin: (room.admin === socket.id), myIndex: room.players.length - 1, target: room.targetScore });
      io.to(roomId).emit("updateRoom", room);
      broadcastRoomList();
    } else socket.emit("errorMsg", "Masa dolu!");
}

function leaveRoom(socket) {
    let roomId = null;
    for(let key in rooms) {
        if(rooms[key].players.find(p => p.id === socket.id)) { roomId = key; break; }
    }
    if(roomId) {
        let room = rooms[roomId];
        room.players = room.players.filter(p => p.id !== socket.id);
        socket.leave(roomId);
        if (room.players.length === 0) delete rooms[roomId];
        else {
            if(room.admin === socket.id && !room.players[0].isBot) room.admin = room.players[0].id;
            io.to(roomId).emit("updateRoom", room);
            if(room.gameStarted && !room.players.some(p => !p.isBot)) delete rooms[roomId];
        }
        broadcastRoomList();
    }
}

function startRound(room, isFirst) {
    if (!isFirst) {
        room.roundStarterIndex = (room.roundStarterIndex + 1) % room.players.length;
        room.turnIndex = room.roundStarterIndex;
    }
    room.teamAPile = []; room.teamBPile = []; room.centerPile = []; room.lastWinnerTeam = null;
    createDeck(room);
    for(let i=0; i<4; i++) room.centerPile.push(room.deck.pop());
    dealCards(room);
    io.to(room.id).emit("gameStarted", room);
    io.to(room.id).emit("updateScores", { scoreA: room.totalScoreA, scoreB: room.totalScoreB });
    checkBotTurn(room);
}

function processMove(room, player, cardIndex) {
    if(!player.hand[cardIndex]) return;
    let playedCard = player.hand.splice(cardIndex, 1)[0]; 
    let team = (room.players.indexOf(player) % 2 === 0) ? 'A' : 'B';

    room.centerPile.push(playedCard);
    io.to(room.id).emit("updateGame", room);

    let captured = false;
    if (room.centerPile.length >= 2) {
        let prev = room.centerPile[room.centerPile.length - 2];
        if (playedCard.value === prev.value || playedCard.value === 'J') {
            captured = true;
            if (room.centerPile.length === 2 && playedCard.value === prev.value) playedCard.isPisti = true; 
        }
    }

    if (captured) {
        setTimeout(() => {
            if (team === 'A') room.teamAPile.push(...room.centerPile);
            else room.teamBPile.push(...room.centerPile);
            room.centerPile = []; room.lastWinnerTeam = team;
            finishTurn(room);
        }, 800); // Hızlandırıldı
    } else {
        finishTurn(room);
    }
}

function finishTurn(room) {
    let empty = room.players.every(p => p.hand.length === 0);
    if (empty) {
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

function calculateRoundEnd(room) {
    if (room.lastWinnerTeam) {
        if(room.lastWinnerTeam === 'A') room.teamAPile.push(...room.centerPile);
        else room.teamBPile.push(...room.centerPile);
        room.centerPile = [];
    }
    let sA = calcScore(room.teamAPile);
    let sB = calcScore(room.teamBPile);
    if(room.teamAPile.length > room.teamBPile.length) sA += 3;
    else if(room.teamBPile.length > room.teamAPile.length) sB += 3;
    room.totalScoreA += sA; room.totalScoreB += sB;

    if (room.totalScoreA >= room.targetScore || room.totalScoreB >= room.targetScore) {
        let winner = (room.totalScoreA > room.totalScoreB) ? "Takım A" : "Takım B";
        io.to(room.id).emit("matchOver", { scoreA: room.totalScoreA, scoreB: room.totalScoreB, winner });
        room.gameStarted = false;
    } else {
        io.to(room.id).emit("roundOver", {});
        setTimeout(() => startRound(room, false), 3000);
    }
}

function calcScore(pile) {
    let s = 0;
    pile.forEach(c => {
        if (c.isPisti) s += (c.value === 'J') ? 20 : 10;
        else {
            if (c.value === 'A' || c.value === 'J') s += 1;
            if (c.suit === '♦' && c.value === '10') s += 3;
            if (c.suit === '♣' && c.value === '2') s += 2;
        }
    });
    return s;
}

function checkBotTurn(room) {
    let p = room.players[room.turnIndex];
    if (p && p.isBot && room.gameStarted) setTimeout(() => botPlay(room, p), 1000);
}

function botPlay(room, bot) {
    if(!bot.hand.length) return;
    let idx = 0;
    if(room.centerPile.length > 0) {
        let top = room.centerPile[room.centerPile.length-1];
        let m = bot.hand.findIndex(c => c.value === top.value);
        if(m !== -1) idx = m;
        else {
            let j = bot.hand.findIndex(c => c.value === 'J');
            if(j !== -1) idx = j;
            else idx = Math.floor(Math.random() * bot.hand.length);
        }
    } else idx = Math.floor(Math.random() * bot.hand.length);
    processMove(room, bot, idx);
}

function createDeck(room) {
    const s=['♥','♦','♣','♠'], v=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    room.deck = [];
    for(let su of s) for(let val of v) room.deck.push({suit:su, value:val});
    room.deck.sort(() => Math.random() - 0.5);
}
function dealCards(room) {
    room.players.forEach(p => { p.hand = []; for(let i=0; i<4; i++) if(room.deck.length) p.hand.push(room.deck.pop()); });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on ${PORT}`));
