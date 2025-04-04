// Serveur Node.js avec Express et WebSocket
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir les fichiers statiques
app.use(express.static(path.join(__dirname, 'public')));

// Structure pour gérer les parties
const games = {};
const clients = {};

// Modèle Pub/Sub
const PubSub = {
  subscribers: {},
  
  subscribe: function(gameId, clientId, callback) {
    if (!this.subscribers[gameId]) {
      this.subscribers[gameId] = {};
    }
    this.subscribers[gameId][clientId] = callback;
  },
  
  publish: function(gameId, data) {
    if (!this.subscribers[gameId]) return;
    
    Object.values(this.subscribers[gameId]).forEach(callback => {
      callback(data);
    });
  },
  
  unsubscribe: function(gameId, clientId) {
    if (this.subscribers[gameId] && this.subscribers[gameId][clientId]) {
      delete this.subscribers[gameId][clientId];
    }
  }
};

// Gestionnaire de connexion WebSocket
wss.on('connection', (ws) => {
  const clientId = Date.now().toString();
  clients[clientId] = ws;
  
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    switch (data.type) {
      case 'create_game':
        handleCreateGame(clientId, data);
        break;
      case 'join_game':
        handleJoinGame(clientId, data);
        break;
      case 'make_move':
        handleMakeMove(clientId, data);
        break;
      default:
        console.log('Message non reconnu:', data);
    }
  });
  
  ws.on('close', () => {
    // Désabonner le client de tous les jeux
    Object.keys(PubSub.subscribers).forEach(gameId => {
      PubSub.unsubscribe(gameId, clientId);
    });
    delete clients[clientId];
  });
  
  // Envoyer l'ID du client
  ws.send(JSON.stringify({
    type: 'connected',
    clientId
  }));
});

function handleCreateGame(clientId, data) {
  const gameId = generateGameId();
  
  games[gameId] = {
    id: gameId,
    board: Array(9).fill(null),
    players: { X: clientId, O: null },
    currentTurn: 'X',
    status: 'waiting'
  };
  
  // Abonner le joueur au jeu
  PubSub.subscribe(gameId, clientId, (gameData) => {
    if (clients[clientId]) {
      clients[clientId].send(JSON.stringify(gameData));
    }
  });
  
  // Notifier le joueur de la création réussie
  PubSub.publish(gameId, {
    type: 'game_created',
    gameId,
    game: games[gameId]
  });
}

function handleJoinGame(clientId, data) {
  const { gameId } = data;
  const game = games[gameId];
  
  if (!game) {
    clients[clientId].send(JSON.stringify({
      type: 'error',
      message: 'Partie introuvable'
    }));
    return;
  }
  
  if (game.players.O) {
    clients[clientId].send(JSON.stringify({
      type: 'error',
      message: 'Partie complète'
    }));
    return;
  }
  
  // Ajouter le second joueur
  game.players.O = clientId;
  game.status = 'playing';
  
  // Abonner le nouveau joueur
  PubSub.subscribe(gameId, clientId, (gameData) => {
    if (clients[clientId]) {
      clients[clientId].send(JSON.stringify(gameData));
    }
  });
  
  // Notifier les deux joueurs
  PubSub.publish(gameId, {
    type: 'game_started',
    game
  });
}

function handleMakeMove(clientId, data) {
  const { gameId, position } = data;
  const game = games[gameId];
  
  if (!game) return;
  
  // Déterminer quel symbole le joueur utilise
  let playerSymbol = null;
  if (game.players.X === clientId) {
    playerSymbol = 'X';
  } else if (game.players.O === clientId) {
    playerSymbol = 'O';
  } else {
    return; // Ce joueur n'est pas dans la partie
  }
  
  // Vérifier si c'est le tour du joueur
  if (game.status !== 'playing' || 
      game.currentTurn !== playerSymbol || 
      game.board[position] !== null || 
      position < 0 || 
      position > 8) {
    return;
  }
  
  // Effectuer le mouvement
  game.board[position] = playerSymbol;
  
  // Vérifier si le jeu est terminé
  const winner = checkWinner(game.board);
  if (winner) {
    game.status = 'finished';
    game.winner = winner;
    
    PubSub.publish(gameId, {
      type: 'game_over',
      game,
      winner
    });
    return;
  }
  
  // Vérifier si c'est un match nul
  if (!game.board.includes(null)) {
    game.status = 'finished';
    
    PubSub.publish(gameId, {
      type: 'game_over',
      game,
      winner: null // Match nul
    });
    return;
  }
  
  // Changer de tour
  game.currentTurn = game.currentTurn === 'X' ? 'O' : 'X';
  
  // Notifier les joueurs
  PubSub.publish(gameId, {
    type: 'move_made',
    game
  });
}

function checkWinner(board) {
  const winPatterns = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // lignes
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // colonnes
    [0, 4, 8], [2, 4, 6]             // diagonales
  ];
  
  for (const pattern of winPatterns) {
    const [a, b, c] = pattern;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  
  return null;
}

function generateGameId() {
  return Math.random().toString(36).substring(2, 8);
}

// Démarrer le serveur
const PORT = 1111;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});