// Serveur Node.js avec Express et WebSocket
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir les fichiers statiques depuis le dossier 'public'
// Assurez-vous que morpion.html est dans un dossier 'public' à côté de server.js
app.use(express.static(path.join(__dirname, 'public')));

// Structure pour gérer les parties et les clients connectés
const games = {};       // Stocke l'état de chaque partie { gameId: gameData }
const clients = {};     // Stocke les connexions WebSocket { clientId: ws }

// Modèle Pub/Sub simple pour la communication spécifique aux parties
const PubSub = {
    subscribers: {}, // { gameId: { clientId: callback, ... }, ... }

    subscribe: function(gameId, clientId, callback) {
        if (!this.subscribers[gameId]) {
            this.subscribers[gameId] = {};
        }
        // Le callback ici est une fonction qui enverra les données au client spécifique
        this.subscribers[gameId][clientId] = callback;
        console.log(`Client ${clientId} subscribed to game ${gameId}`);
    },

    publish: function(gameId, data) {
        if (!this.subscribers[gameId]) {
             console.log(`No subscribers for game ${gameId} to publish to.`);
            return;
        }

        console.log(`Publishing to game ${gameId}:`, data);
        const messageString = JSON.stringify(data); // Sérialiser une seule fois

        Object.entries(this.subscribers[gameId]).forEach(([subClientId, callback]) => {
            // Vérifier si le client est toujours connecté
            const clientWs = clients[subClientId];
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                try {
                    // On utilise directement la référence WebSocket stockée dans `clients`
                    // La 'callback' stockée n'est plus nécessaire pour le send ici,
                    // mais elle était utile pour lier client et game lors de l'abonnement.
                    clientWs.send(messageString);
                } catch (e) {
                    console.error(`Error sending message to client ${subClientId} in game ${gameId}:`, e);
                    // Optionnel : Gérer l'erreur, peut-être désabonner le client
                    this.unsubscribe(gameId, subClientId);
                    delete clients[subClientId]; // Nettoyer la référence client globale
                }
            } else {
                // Nettoyer les abonnés qui ne sont plus connectés
                console.log(`Client ${subClientId} no longer connected, unsubscribing from game ${gameId}.`);
                this.unsubscribe(gameId, subClientId);
                // Pas besoin de delete clients[subClientId] ici car géré dans ws.on('close')
            }
        });
    },

    unsubscribe: function(gameId, clientId) {
        if (this.subscribers[gameId] && this.subscribers[gameId][clientId]) {
            delete this.subscribers[gameId][clientId];
            console.log(`Client ${clientId} unsubscribed from game ${gameId}`);
            // Si plus aucun abonné pour cette partie, nettoyer l'entrée
            if (Object.keys(this.subscribers[gameId]).length === 0) {
                delete this.subscribers[gameId];
                console.log(`No more subscribers for game ${gameId}, removing subscription entry.`);
                // On pourrait aussi supprimer la partie de `games` ici si elle est terminée ou abandonnée
                // if (games[gameId] && (games[gameId].status === 'finished' || games[gameId].status === 'aborted')) {
                //     delete games[gameId];
                //     console.log(`Game ${gameId} removed as it is finished/aborted and has no subscribers.`);
                // }
            }
        }
    },

    // Helper pour obtenir les IDs des clients dans un jeu (moins utilisé maintenant avec publish direct)
    getSubscribers: function(gameId) {
        return this.subscribers[gameId] ? Object.keys(this.subscribers[gameId]) : [];
    }
};


// Gestionnaire de connexion WebSocket
wss.on('connection', (ws) => {
    const clientId = Date.now().toString() + Math.random().toString(36).substring(2, 6);
    clients[clientId] = ws;
    console.log(`Client ${clientId} connected.`);

    ws.on('message', (message) => {
        let data;
        try {
             // Les messages WebSocket sont souvent des Buffers, les convertir en string d'abord
            data = JSON.parse(message.toString());
        } catch (e) {
            console.error(`Failed to parse JSON message from ${clientId}:`, message.toString(), e);
            return; // Ignorer le message invalide
        }

        console.log(`Message received from ${clientId}:`, data);

        // Attacher clientId à la donnée pour que les handlers sachent qui a envoyé
        // Bien que souvent on utilise le clientId passé en argument au handler
        // data.clientId = clientId;

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
            case 'request_replay':
                handleRequestReplay(clientId, data);
                break;
            case 'send_message': // Gérer les messages de chat
                handleSendMessage(clientId, data);
                break;
            default:
                console.log(`Unrecognized message type from ${clientId}:`, data.type);
                // Optionnel: envoyer une erreur au client
                 if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', message: `Type de message inconnu: ${data.type}` }));
                 }
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`Client ${clientId} disconnected. Code: ${code}, Reason: ${reason}`);
        // Gérer la déconnexion d'un joueur d'une partie en cours ou en attente
        handleDisconnect(clientId);
        // Supprimer la référence client
        delete clients[clientId];
    });

    ws.on('error', (error) => {
         console.error(`WebSocket error for client ${clientId}:`, error);
         // La connexion se ferme généralement après une erreur, 'close' sera aussi appelé
         handleDisconnect(clientId); // Gérer aussi la déconnexion ici par sécurité
         delete clients[clientId];
    });


    // Envoyer l'ID unique au client dès la connexion
     if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'connected', clientId }));
     }
});

// --- Fonctions de gestion de jeu ---

function handleCreateGame(clientId, data) {
    const gameId = generateGameId();

    games[gameId] = {
        id: gameId,
        board: Array(9).fill(null),
        players: { X: clientId, O: null }, // Qui joue X, qui joue O
        playerSymbols: { [clientId]: 'X' }, // Map clientId -> symbol ('X' ou 'O')
        currentTurn: 'X', // X commence toujours la première manche
        starter: 'X', // Qui a commencé cette manche (pour alterner)
        status: 'waiting', // 'waiting', 'playing', 'finished', 'aborted'
        replayRequestedBy: new Set(), // Stocke les clientId demandant à rejouer
        // winner: null // Défini à la fin de la partie
    };

    // Abonner le créateur à sa propre partie pour recevoir les mises à jour
    // Le callback ici pourrait être simplifié si on utilise directement clients[clientId].send dans publish
    PubSub.subscribe(gameId, clientId, (gameData) => {
        // Cette fonction callback n'est plus strictement nécessaire si publish utilise `clients[subClientId].send`
        // console.log(`Callback triggered for ${clientId} in game ${gameId}`);
    });

    // Notifier le créateur que la partie est créée et envoyer l'état initial
    PubSub.publish(gameId, {
        type: 'game_created',
        gameId,
        game: games[gameId] // Envoyer l'état complet du jeu
    });
    console.log(`Game ${gameId} created by ${clientId}. Waiting for player O.`);
}

function handleJoinGame(clientId, data) {
    const { gameId } = data;
    const game = games[gameId];
    const clientWs = clients[clientId]; // Référence WebSocket du client qui tente de rejoindre

     // Vérifier si le client est connecté
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
        console.log(`Join attempt ignored: Client ${clientId} not connected.`);
        return;
    }

    // Vérifier si la partie existe
    if (!game) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Partie introuvable.' }));
        console.log(`Join attempt failed: Game ${gameId} not found for client ${clientId}.`);
        return;
    }

    // Vérifier si la partie est déjà pleine
    if (game.players.O !== null) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Cette partie est déjà complète.' }));
        console.log(`Join attempt failed: Game ${gameId} is full (Player O is ${game.players.O}). Client ${clientId} rejected.`);
        return;
    }

    // Vérifier si le joueur essaie de rejoindre sa propre partie (déjà joueur X)
    if (game.players.X === clientId) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Vous êtes déjà le joueur X dans cette partie.' }));
        console.log(`Join attempt failed: Client ${clientId} is already Player X in game ${gameId}.`);
        return;
    }

    // Ajouter le second joueur
    game.players.O = clientId;
    game.playerSymbols[clientId] = 'O';
    game.status = 'playing';
    game.replayRequestedBy.clear(); // Réinitialiser les demandes de rejouer au début

    // Abonner le nouveau joueur (O) à la partie
    PubSub.subscribe(gameId, clientId, (gameData) => { /* Callback peut rester vide */ });

    // Notifier les deux joueurs que la partie commence
    PubSub.publish(gameId, {
        type: 'game_started',
        game // Envoyer l'état mis à jour du jeu
    });
    console.log(`Client ${clientId} joined game ${gameId} as Player O. Game started.`);
}

function handleMakeMove(clientId, data) {
    const { gameId, position } = data;
    const game = games[gameId];

    // --- Validations Robustes ---
    if (!game) {
        console.log(`Move ignored: Game ${gameId} not found for client ${clientId}.`);
        return;
    }
    const playerSymbol = game.playerSymbols[clientId];
    if (!playerSymbol) {
        console.log(`Move ignored: Client ${clientId} is not a player in game ${gameId}.`);
        // Optionnel : notifier le client qu'il n'est pas joueur
        // if (clients[clientId] && clients[clientId].readyState === WebSocket.OPEN) {
        //     clients[clientId].send(JSON.stringify({ type: 'error', message: 'Vous n\'êtes pas un joueur dans cette partie.' }));
        // }
        return;
    }
    if (game.status !== 'playing') {
        console.log(`Move ignored: Game ${gameId} is not in 'playing' status (current: ${game.status}). Client: ${clientId}.`);
        return; // Ne peut pas jouer si la partie n'est pas en cours
    }
    if (game.currentTurn !== playerSymbol) {
        console.log(`Move ignored: It's not ${playerSymbol}'s turn (current: ${game.currentTurn}) in game ${gameId}. Client: ${clientId}.`);
        // Optionnel : notifier le client que ce n'est pas son tour
        // if (clients[clientId] && clients[clientId].readyState === WebSocket.OPEN) {
        //     clients[clientId].send(JSON.stringify({ type: 'error', message: 'Ce n\'est pas votre tour.' }));
        // }
        return;
    }
    if (position === undefined || position === null || position < 0 || position > 8 || !Number.isInteger(position)) {
        console.log(`Move ignored: Invalid position '${position}' in game ${gameId}. Client: ${clientId}.`);
        return;
    }
    if (game.board[position] !== null) {
        console.log(`Move ignored: Position ${position} is already taken by ${game.board[position]} in game ${gameId}. Client: ${clientId}.`);
         // Optionnel : notifier le client que la case est prise
        // if (clients[clientId] && clients[clientId].readyState === WebSocket.OPEN) {
        //     clients[clientId].send(JSON.stringify({ type: 'error', message: 'Cette case est déjà prise.' }));
        // }
        return;
    }
    // --- Fin Validations ---

    // Effectuer le mouvement
    game.board[position] = playerSymbol;
    console.log(`Move made by ${clientId} (${playerSymbol}) at position ${position} in game ${gameId}.`);

    // Vérifier l'état du jeu après le mouvement
    const winner = checkWinner(game.board);
    const isDraw = !winner && !game.board.includes(null);

    if (winner) {
        game.status = 'finished';
        game.winner = winner;
        console.log(`Game ${gameId} finished. Winner: ${winner}.`);
        PubSub.publish(gameId, {
            type: 'game_over',
            game,
            winner
        });
    } else if (isDraw) {
        game.status = 'finished';
        game.winner = null; // Indiquer un match nul
        console.log(`Game ${gameId} finished. Result: Draw.`);
        PubSub.publish(gameId, {
            type: 'game_over',
            game,
            winner: null // Explicitement nul pour match nul
        });
    } else {
        // La partie continue, changer de tour
        game.currentTurn = game.currentTurn === 'X' ? 'O' : 'X';
        PubSub.publish(gameId, {
            type: 'move_made',
            game // Envoyer le nouvel état du jeu
        });
    }
}

function handleRequestReplay(clientId, data) {
    const { gameId } = data;
    const game = games[gameId];

    if (!game) {
        console.log(`Replay request ignored: Game ${gameId} not found for client ${clientId}.`);
        return;
    }
    if (game.status !== 'finished') {
        console.log(`Replay request ignored: Game ${gameId} is not finished (status: ${game.status}). Client: ${clientId}.`);
        return; // Ne peut demander à rejouer que si la partie est finie
    }
    if (!game.playerSymbols[clientId]) {
        console.log(`Replay request ignored: Client ${clientId} is not a player in game ${gameId}.`);
        return;
    }

    // Ajouter la demande du client (Set gère les doublons)
    game.replayRequestedBy.add(clientId);
    console.log(`Client ${clientId} requested replay for game ${gameId}. Current requests: ${[...game.replayRequestedBy].join(', ')}`);

    // Notifier le client que sa demande est enregistrée (bon pour l'UX)
    const clientWs = clients[clientId];
    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'replay_request_acknowledged', gameId }));
    }

    // Vérifier si les deux joueurs ont demandé
    const playerIds = Object.values(game.players).filter(id => id !== null); // ['id1', 'id2']
    if (playerIds.length === 2 && game.replayRequestedBy.size === 2) {
        // Les deux joueurs veulent rejouer
        console.log(`Both players (${playerIds.join(', ')}) requested replay for game ${gameId}. Resetting game...`);
        resetGame(gameId); // Réinitialiser et redémarrer
    } else if (playerIds.length === 2) {
        // Informer l'autre joueur de la demande (s'il ne l'a pas déjà fait)
        const opponentId = playerIds.find(id => id !== clientId);
        if (opponentId && !game.replayRequestedBy.has(opponentId)) {
            const opponentWs = clients[opponentId];
            if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
                opponentWs.send(JSON.stringify({
                    type: 'replay_requested', // L'autre joueur a demandé
                    gameId,
                    requesterId: clientId // Qui a demandé
                }));
                console.log(`Notified opponent ${opponentId} about replay request from ${clientId} for game ${gameId}.`);
            }
        }
    } else {
         console.log(`Replay request from ${clientId} for game ${gameId}, but waiting for opponent (or opponent missing).`);
    }
}

function handleSendMessage(clientId, data) {
    const { gameId, message } = data;
    const game = games[gameId];

    // Validations
    if (!game) {
        console.log(`Chat message ignored: Game ${gameId} not found for client ${clientId}.`);
        return;
    }
    const playerSymbol = game.playerSymbols[clientId];
    if (!playerSymbol) {
        console.log(`Chat message ignored: Client ${clientId} is not a player in game ${gameId}.`);
        return;
    }
     // Permettre de chatter même si la partie est 'finished' ou 'waiting' ? Oui.
    // if (game.status === 'aborted') return; // Peut-être bloquer si abandonné

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        console.log(`Chat message ignored: Empty or invalid message from ${clientId} in game ${gameId}.`);
        return;
    }

    // Nettoyer et limiter la taille du message
    const cleanMessage = message.trim().substring(0, 250); // Limite à 250 caractères

    console.log(`[Chat ${gameId}] ${playerSymbol} (${clientId}): ${cleanMessage}`);

    // Préparer le payload à envoyer
    const chatPayload = {
        type: 'chat_message',
        gameId: gameId,
        senderSymbol: playerSymbol, // Envoyer 'X' ou 'O'
        // senderId: clientId, // Envoyer l'ID si le client en a besoin
        message: cleanMessage
    };

    // Diffuser le message à tous les joueurs de la partie
    PubSub.publish(gameId, chatPayload);
}


function resetGame(gameId) {
    const game = games[gameId];
    if (!game) {
        console.error(`Cannot reset game ${gameId}: Not found.`);
        return;
    }

    console.log(`Resetting game ${gameId}...`);

    // Alterner le joueur qui commence la nouvelle manche
    game.starter = game.starter === 'X' ? 'O' : 'X';
    game.currentTurn = game.starter;

    // Réinitialiser l'état du jeu
    game.board = Array(9).fill(null);
    game.status = 'playing'; // Prêt à jouer
    delete game.winner; // Enlever l'ancien gagnant
    game.replayRequestedBy.clear(); // Vider les demandes de rejouer

    // Notifier les joueurs que la nouvelle manche commence
    PubSub.publish(gameId, {
        type: 'game_started', // On réutilise 'game_started' pour envoyer le nouvel état
        game
    });
    console.log(`Game ${gameId} reset. New round started. ${game.currentTurn} begins.`);
}

function checkWinner(board) {
    const winPatterns = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
        [0, 4, 8], [2, 4, 6]             // Diagonals
    ];

    for (const pattern of winPatterns) {
        const [a, b, c] = pattern;
        // Vérifier si les 3 cases du pattern sont non nulles et identiques
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return board[a]; // Retourne 'X' ou 'O'
        }
    }
    return null; // Pas de gagnant
}

function generateGameId() {
    // Génère un ID court et aléatoire (pas garanti unique mais suffisant pour ce cas)
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function handleDisconnect(clientId) {
    console.log(`Handling disconnect for client ${clientId}...`);
    // Trouver la partie dans laquelle le client se trouvait
    let gameFound = null;
    for (const gameId in games) {
        const game = games[gameId];
        const playerX = game.players.X;
        const playerO = game.players.O;

        if (playerX === clientId || playerO === clientId) {
            gameFound = game;
             console.log(`Client ${clientId} was in game ${gameId}.`);
            // 1. Désabonner le joueur déconnecté
            PubSub.unsubscribe(gameId, clientId);

            // 2. Gérer l'impact sur la partie
            const opponentId = (playerX === clientId) ? playerO : playerX;

            // Si la partie attendait un joueur et que c'est le créateur qui part
            if (game.status === 'waiting' && playerX === clientId) {
                 console.log(`Game ${gameId} aborted because creator ${clientId} disconnected before opponent joined.`);
                 game.status = 'aborted';
                 // Supprimer la partie car elle ne peut pas continuer
                 delete games[gameId];
                 // Les abonnements sont déjà nettoyés par unsubscribe
            }
            // Si la partie était en cours ou finie et qu'il y avait un adversaire
            else if (opponentId && (game.status === 'playing' || game.status === 'finished')) {
                 console.log(`Notifying opponent ${opponentId} about disconnection of ${clientId} in game ${gameId}.`);
                 game.status = 'aborted'; // Marquer la partie comme abandonnée
                 delete game.winner; // Pas de gagnant si abandon
                 game.replayRequestedBy.clear(); // Annuler les demandes de rejouer

                 // Notifier l'adversaire resté en ligne
                 const opponentWs = clients[opponentId];
                 if (opponentWs && opponentWs.readyState === WebSocket.OPEN) {
                     opponentWs.send(JSON.stringify({
                         type: 'opponent_disconnected',
                         gameId: gameId,
                         disconnectedPlayerId: clientId,
                         message: 'Votre adversaire s\'est déconnecté. La partie est terminée.'
                     }));
                     // On pourrait aussi désabonner l'adversaire ici, car la partie est finie/abandonnée
                     // PubSub.unsubscribe(gameId, opponentId);
                 }
                 // Optionnel : Supprimer la partie après un délai ? Pour l'instant on la garde comme 'aborted'.
            }
             // Si c'est le joueur O qui se déconnecte pendant l'attente (ne devrait pas arriver)
             else if (game.status === 'waiting' && playerO === clientId) {
                 console.warn(`Player O (${clientId}) disconnected while game ${gameId} was waiting? Resetting player O.`);
                 game.players.O = null;
                 delete game.playerSymbols[clientId];
                 // La partie redevient en attente
             }


            // Un client ne peut être que dans une seule partie à la fois dans ce modèle
            break;
        }
    }
     if (!gameFound) {
         console.log(`Client ${clientId} was not found in any active game.`);
     }
}


// Démarrer le serveur
const PORT = process.env.PORT || 1111;
server.listen(PORT, () => {
    console.log(`Tic-Tac-Toe WebSocket server started on port ${PORT}`);
    console.log(`Access the game via http://localhost:${PORT}`);
});