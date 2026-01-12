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

function broadcastRoomList() {
    let list = [];
    for (let key in rooms) {
        let r = rooms[key];
        // Sadece dolu koltuk sayısını (botlar dahil) say
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

  // --- SESLİ SOHBET ---
  socket.on("voice", (data) => {
      let room = rooms[data.roomId];
      // Sadece aynı odadaysa ve oyundaysa (koltuktaysa) sesi ilet
      if (room && isPlayerInRoom(room, socket.id)) {
          socket.to(data.roomId).emit("voice", data.blob);
      }
  });

  socket.on("speaking", (data) => {
      let room = rooms[data.roomId];
      if (room) {
          socket.to(data.roomId).emit("playerSpeaking", { 
              id: socket.id, 
              isSpeaking: data.isSpeaking 
          });
      }
  });

  // --- ODA YÖNETİMİ ---
  socket.on("createRoom", (data) => {
    let roomId = data.roomId;
    if (rooms[roomId]) {
      socket.emit("errorMsg", "Bu isimde bir masa zaten var!");
    } else {
      rooms[roomId] = {
        id: roomId, 
        seats: {0: null, 1: null, 2: null, 3: null}, // 4 Koltuk
        deck: [], centerPile: [], teamAPile: [], teamBPile: [],
        totalScoreA: 0, totalScoreB: 0, targetScore: 151,
        gameStarted: false, turnIndex: 0, roundStarterIndex: 0, admin: socket.id, lastWinnerTeam: null 
      };
      
      // Kurucu otomatik 0. koltuğa oturur
      socket.join(roomId);
      rooms[roomId].seats[0] = { id: socket.id, name: data.username, isBot: false, hand: [] };
      
      io.to(roomId).emit("updateRoom", rooms[roomId]);
      broadcastRoomList();
      // Kurucuya admin olduğunu bildir
      socket.emit("joined", { roomId: roomId, isAdmin: true, mySeat: 0 });
    }
  });

  socket.on("joinRoom", (data) => {
      let room = rooms[data.roomId];
      if (!room) {
          socket.emit("errorMsg", "Masa bulunamadı.");
          return;
      }
      
      // Odaya gir ama koltuğa oturma (İzleyici modu gibi başlar)
      socket.join(data.roomId);
      
      // Kullanıcıya odayı göster, koltuk seçmesini bekle
      socket.emit("joined", { roomId: data.roomId, isAdmin: false, mySeat: -1 }); // -1: Koltuksuz
      socket.emit("updateRoom", room);
  });

  // --- KOLTUK SEÇİMİ ---
  socket.on("sitDown", (data) => {
      let room = rooms[data.roomId];
      let seatIdx = parseInt(data.seatIndex);
      
      if (!room || room.gameStarted) return;
      if (room.seats[seatIdx] !== null) return; // Doluysa oturamaz

      // Önce eski koltuğu varsa kaldır (yer değiştirme)
      for(let i=0; i<4; i++) {
          if(room.seats[i] && room.seats[i].id === socket.id) {
              room.seats[i] = null;
          }
      }

      // Yeni koltuğa oturt
      room.seats[seatIdx] = { id: socket.id, name: data.username, isBot: false, hand: [] };
      
      io.to(data.roomId).emit("updateRoom", room);
      socket.emit("joined", { roomId: data.roomId, isAdmin: (room.admin === socket.id), mySeat: seatIdx });
      broadcastRoomList();
  });

  socket.on("addBot", (roomId) => {
    let room = rooms[roomId];
    if (!room || room.gameStarted || room.admin !== socket.id) return;

    // İlk boş koltuğu bul
    for(let i=0; i<4; i++) {
        if(room.seats[i] === null) {
            let botId = "BOT_" + Date.now() + Math.floor(Math.random()*100);
            room.seats[i] = { id: botId, name: "Bot " + (i+1), isBot: true, hand: [] };
            break;
        }
    }
    io.to(roomId).emit("updateRoom", room);
    broadcastRoomList();
  });

  socket.on("startGame", (roomId) => {
    let room = rooms[roomId];
    if (!room || room.admin !== socket.id || room.gameStarted) return;
    
    // Oyuncu sayısını kontrol et (En az 2 kişi/bot)
    let occupiedSeats = Object.values(room.seats).filter(p => p !== null);
    if (occupiedSeats.length < 2) return;

    room.gameStarted = true; room.totalScoreA = 0; room.totalScoreB = 0;
    room.roundStarterIndex = 0; room.turnIndex = 0; // 0. koltuk başlar
    startRound(room, true); 
    broadcastRoomList();
  });

  socket.on("playCard", (data) => {
      let room = rooms[data.roomId];
      if(!room || !room.gameStarted) return;
      
      let player = room.seats[room.turnIndex];
      if(!player || player.id !== socket.id) return; // Sıra sende değil

      processMove(room, player, data.cardIndex);
  });

  socket.on("leaveRoom", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

// --- YARDIMCI FONKSİYONLAR ---

function isPlayerInRoom(room, socketId) {
    return Object.values(room.seats).some(p => p && p.id === socketId);
}

function leaveRoom(socket) {
    let roomId = null;
    // Hangi odada olduğunu bul
    for(let key in rooms) {
        // Socket odasına bakmaya gerek yok, koltuklara bak
        if(Object.values(rooms[key].seats).some(p => p && p.id === socket.id)) {
            roomId = key; break;
        }
        // Eğer koltukta değil ama izleyici ise (joinRoom yapmış ama oturmamış)
        if(socket.rooms.has(key)) {
             roomId = key; break;
        }
    }

    if(roomId) {
        let room = rooms[roomId];
        socket.leave(roomId);

        // Koltuktan kaldır
        for(let i=0; i<4; i++) {
            if(room.seats[i] && room.seats[i].id === socket.id) {
                room.seats[i] = null;
            }
        }

        // Admin çıktıysa ve başka oyuncu varsa adminliği devret
        if(room.admin === socket.id) {
            let nextPlayer = Object.values(room.seats).find(p => p && !p.isBot);
            if(nextPlayer) room.admin = nextPlayer.id;
        }

        io.to(roomId).emit("updateRoom", room);

        // --- BOT TEMİZLİĞİ ---
        // Odada hiç GERÇEK İNSAN kalmadıysa odayı sil
        let hasHuman = Object.values(room.seats).some(p => p && !p.isBot);
        // Ayrıca izleyici modundakileri de kontrol edebiliriz ama basitlik için koltuktakiler yeterli
        // Eğer oyun başladıysa ve insan kalmadıysa sil
        if(!hasHuman) {
            delete rooms[roomId];
        }

        broadcastRoomList();
    }
}

function startRound(room, isFirst) {
    if (!isFirst) {
        // Sırayı bir sonraki dolu koltuğa geçir
        let nextStarter = (room.roundStarterIndex + 1) % 4;
        while(room.seats[nextStarter] === null) {
            nextStarter = (nextStarter + 1) % 4;
        }
        room.roundStarterIndex = nextStarter;
        room.turnIndex = room.roundStarterIndex;
    } else {
        // İlk elde dolu olan ilk koltuk başlar
        while(room.seats[room.turnIndex] === null) {
            room.turnIndex = (room.turnIndex + 1) % 4;
        }
    }

    room.teamAPile = []; room.teamBPile = []; room.centerPile = []; room.lastWinnerTeam = null;
    createDeck(room);
    
    // Yere 4 kart aç
    for(let i=0; i<4; i++) room.centerPile.push(room.deck.pop());
    
    dealCards(room);
    io.to(room.id).emit("gameStarted", room);
    io.to(room.id).emit("updateScores", { scoreA: room.totalScoreA, scoreB: room.totalScoreB });
    
    checkBotTurn(room);
}

function processMove(room, player, cardIndex) {
    if(!player.hand[cardIndex]) return;
    let playedCard = player.hand.splice(cardIndex, 1)[0]; 
    
    // Takım A: 0 ve 2, Takım B: 1 ve 3
    let pIndex = parseInt(Object.keys(room.seats).find(key => room.seats[key] === player));
    let team = (pIndex % 2 === 0) ? 'A' : 'B';

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
        }, 800);
    } else {
        finishTurn(room);
    }
}

function finishTurn(room) {
    // Herkesin eli boş mu?
    let activePlayers = Object.values(room.seats).filter(p => p !== null);
    let allHandsEmpty = activePlayers.every(p => p.hand.length === 0);

    if (allHandsEmpty) {
        if (room.deck.length > 0) {
            dealCards(room);
            // Sıradaki oyuncuya geç
            passTurn(room);
            io.to(room.id).emit("updateGame", { ...room, isDealAnim: true });
            checkBotTurn(room);
        } else calculateRoundEnd(room);
    } else {
        passTurn(room);
        io.to(room.id).emit("updateGame", room); 
        checkBotTurn(room);
    }
}

function passTurn(room) {
    // Bir sonraki DOLU koltuğu bul
    let next = (room.turnIndex + 1) % 4;
    while(room.seats[next] === null) {
        next = (next + 1) % 4;
    }
    room.turnIndex = next;
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
    // Sadece dolu koltuklara kart dağıt
    for(let i=0; i<4; i++) {
        let p = room.seats[i];
        if(p) {
            p.hand = []; 
            for(let k=0; k<4; k++) if(room.deck.length) p.hand.push(room.deck.pop());
        }
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on ${PORT}`));
