const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
    cors: { origin: "*" },
    pingInterval: 10000,
    pingTimeout: 5000,
    maxHttpBufferSize: 1e8 // Kamera ve ses verisi için limit artırıldı
});

app.use(express.static("public"));

let rooms = {};

function broadcastRoomList() {
    let list = [];
    for (let key in rooms) {
        let r = rooms[key];
        let count = Object.values(r.seats).filter(p => p !== null).length;
        list.push({
            id: r.id,
            count: count,
            status: r.gameStarted ? "Oynanıyor" : "Bekliyor"
        });
    }
    io.emit("roomList", list);
}

io.on("connection", (socket) => {
  broadcastRoomList();

  // --- MEDYA İLETİMİ (SES & KAMERA) ---
  socket.on("streamData", (data) => {
      let room = rooms[data.roomId];
      if (room && isPlayerInRoom(room, socket.id)) {
          // Veriyi odaya yay (gönderen hariç)
          socket.to(data.roomId).emit("streamData", {
              id: socket.id,
              type: data.type,
              payload: data.payload
          });
      }
  });

  // --- KONUŞMA SİNYALİ ---
  socket.on("speaking", (data) => {
      let room = rooms[data.roomId];
      if (room) {
          socket.to(data.roomId).emit("playerSpeaking", { 
              id: socket.id, 
              isSpeaking: data.isSpeaking 
          });
      }
  });

  // --- ODA & OYUN MANTIĞI ---
  socket.on("createRoom", (data) => {
    let roomId = data.roomId;
    if (rooms[roomId]) {
      socket.emit("errorMsg", "Bu isimde masa var!");
    } else {
      rooms[roomId] = {
        id: roomId, 
        seats: {0: null, 1: null, 2: null, 3: null},
        deck: [], centerPile: [], teamAPile: [], teamBPile: [],
        totalScoreA: 0, totalScoreB: 0, targetScore: 151,
        gameStarted: false, turnIndex: 0, roundStarterIndex: 0, admin: socket.id, lastWinnerTeam: null 
      };
      socket.join(roomId);
      rooms[roomId].seats[0] = { id: socket.id, name: data.username, isBot: false, hand: [] };
      io.to(roomId).emit("updateRoom", rooms[roomId]);
      socket.emit("joined", { roomId: roomId, isAdmin: true, mySeat: 0 });
      broadcastRoomList();
    }
  });

  socket.on("joinRoom", (data) => {
      let room = rooms[data.roomId];
      if (!room) { socket.emit("errorMsg", "Masa bulunamadı."); return; }
      socket.join(data.roomId);
      socket.emit("joined", { roomId: data.roomId, isAdmin: (room.admin === socket.id), mySeat: -1 });
      socket.emit("updateRoom", room);
  });

  socket.on("sitDown", (data) => {
      let room = rooms[data.roomId];
      let seatIdx = parseInt(data.seatIndex);
      if (!room || room.gameStarted || room.seats[seatIdx] !== null) return;

      for(let i=0; i<4; i++) if(room.seats[i] && room.seats[i].id === socket.id) room.seats[i] = null;
      room.seats[seatIdx] = { id: socket.id, name: data.username, isBot: false, hand: [] };
      
      io.to(data.roomId).emit("updateRoom", room);
      socket.emit("joined", { roomId: data.roomId, isAdmin: (room.admin === socket.id), mySeat: seatIdx });
      broadcastRoomList();
    });

  socket.on("startGame", (roomId) => {
    let room = rooms[roomId];
    if (!room || room.admin !== socket.id || room.gameStarted) return;
    
    for(let i=0; i<4; i++) {
        if(room.seats[i] === null) {
            let botId = "BOT_" + Date.now() + "_" + i;
            room.seats[i] = { id: botId, name: "Bot " + (i+1), isBot: true, hand: [] };
        }
    }

    room.gameStarted = true; room.totalScoreA = 0; room.totalScoreB = 0;
    room.turnIndex = 0; room.roundStarterIndex = 0;
    
    startRound(room, true); 
    broadcastRoomList();
  });

  socket.on("playCard", (data) => {
      let room = rooms[data.roomId];
      if(!room || !room.gameStarted) return;
      let p = room.seats[room.turnIndex];
      if(!p || p.id !== socket.id) return;
      processMove(room, p, data.cardIndex);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

function isPlayerInRoom(room, socketId) {
    return Object.values(room.seats).some(p => p && p.id === socketId);
}

function leaveRoom(socket) {
    let roomId = null;
    for(let key in rooms) {
        if(Object.values(rooms[key].seats).some(p => p && p.id === socket.id) || socket.rooms.has(key)) {
            roomId = key; break;
        }
    }
    if(roomId) {
        let room = rooms[roomId];
        socket.leave(roomId);
        for(let i=0; i<4; i++) if(room.seats[i] && room.seats[i].id === socket.id) room.seats[i] = null;
        
        let hasHuman = Object.values(room.seats).some(p => p && !p.isBot);
        if(!hasHuman) {
            delete rooms[roomId];
        } else {
            if(room.admin === socket.id) {
                let nextP = Object.values(room.seats).find(p => p && !p.isBot);
                if(nextP) room.admin = nextP.id;
            }
            io.to(roomId).emit("updateRoom", room);
        }
        broadcastRoomList();
    }
}

function startRound(room, isFirst) {
    if (!isFirst) {
        room.roundStarterIndex = (room.roundStarterIndex + 1) % 4;
        room.turnIndex = room.roundStarterIndex;
    }
    room.teamAPile = []; room.teamBPile = []; room.centerPile = []; room.lastWinnerTeam = null;
    createDeck(room);
    for(let i=0; i<4; i++) room.centerPile.push(room.deck.pop());
    dealCards(room);
    io.to(room.id).emit("gameStarted", room);
    checkBotTurn(room);
}

function processMove(room, player, cardIndex) {
    if(!player.hand[cardIndex]) return;
    let playedCard = player.hand.splice(cardIndex, 1)[0]; 
    let pIdx = parseInt(Object.keys(room.seats).find(k => room.seats[k] === player));
    let team = (pIdx % 2 === 0) ? 'A' : 'B';

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
            if (team === 'A') room.teamAPile.push(...room.centerPile); else room.teamBPile.push(...room.centerPile);
            room.centerPile = []; room.lastWinnerTeam = team;
            finishTurn(room);
        }, 800);
    } else finishTurn(room);
}

function finishTurn(room) {
    let active = Object.values(room.seats).filter(p => p !== null);
    if (active.every(p => p.hand.length === 0)) {
        if (room.deck.length > 0) {
            dealCards(room);
            room.turnIndex = (room.turnIndex + 1) % 4;
            io.to(room.id).emit("updateGame", { ...room, isDealAnim: true });
            checkBotTurn(room);
        } else calculateRoundEnd(room);
    } else {
        room.turnIndex = (room.turnIndex + 1) % 4;
        io.to(room.id).emit("updateGame", room); 
        checkBotTurn(room);
    }
}

function calculateRoundEnd(room) {
    if (room.lastWinnerTeam) {
        if(room.lastWinnerTeam === 'A') room.teamAPile.push(...room.centerPile); else room.teamBPile.push(...room.centerPile);
        room.centerPile = [];
    }
    let sA = calcScore(room.teamAPile), sB = calcScore(room.teamBPile);
    if(room.teamAPile.length > room.teamBPile.length) sA += 3; else if(room.teamBPile.length > room.teamAPile.length) sB += 3;
    room.totalScoreA += sA; room.totalScoreB += sB;

    if (room.totalScoreA >= room.targetScore || room.totalScoreB >= room.targetScore) {
        let winner = (room.totalScoreA > room.totalScoreB) ? "Takım A" : "Takım B";
        io.to(room.id).emit("matchOver", { scoreA: room.totalScoreA, scoreB: room.totalScoreB, winner });
        room.gameStarted = false;
    } else {
        io.to(room.id).emit("roundOver", {
            scoreA: room.totalScoreA,
            scoreB: room.totalScoreB,
            target: room.targetScore,
            lastRoundA: sA,
            lastRoundB: sB
        });
        setTimeout(() => startRound(room, false), 5000);
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
    let p = room.seats[room.turnIndex];
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
            if(j !== -1) idx = j; else idx = Math.floor(Math.random() * bot.hand.length);
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
    for(let i=0; i<4; i++) if(room.seats[i]) { room.seats[i].hand = []; for(let k=0; k<4; k++) if(room.deck.length) room.seats[i].hand.push(room.deck.pop()); }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on ${PORT}`));
