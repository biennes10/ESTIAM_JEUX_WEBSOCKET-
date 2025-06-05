// Serveur Node.js avec Express et WebSocket
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import jwt from 'jsonwebtoken'; // Importation de jsonwebtoken
import pool from './config/database.js'; // Importation du pool de connexions à la base de données
import { verify } from 'argon2';// Importation de argon2
import { hash } from 'argon2';
import { fileURLToPath } from 'url';
import { body, validationResult } from 'express-validator';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware pour parser le corps des requêtes JSON
app.use(express.json());

// Servir les fichiers statiques (index.html, morpion.html, puissance4.html, etc.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// Structure pour gérer les parties et les clients
const games = {}; // Stocke l'état de chaque partie { gameId: gameData }
const clients = {}; // Stocke les connexions WebSocket { clientId: ws }

// Clé secrète pour signer les JWT (à garder en sécurité dans une variable d'environnement !)
const JWT_SECRET = process.env.JWT_SECRET || 'votreClesSecreteTresLongueEtComplexe';

// --- Constantes Puissance 4 ---
const P4_COLUMNS = 7;
const P4_ROWS = 6;
const P4_BOARD_SIZE = P4_COLUMNS * P4_ROWS;

// --- Pub/Sub (Inchangé) ---
const PubSub = {
    subscribers: {}, // { gameId: { clientId: callback, ... }, ... }

    subscribe: function(gameId, clientId, callback) {
        if (!this.subscribers[gameId]) {
            this.subscribers[gameId] = {};
        }
        // Le callback ici était une idée initiale, mais on utilise plutôt la référence directe via `clients` dans publish
        this.subscribers[gameId][clientId] = callback; // On stocke juste la présence pour savoir qui écoute
        console.log(`Client ${clientId} subscribed to game ${gameId}`);
    },

    publish: function(gameId, data) {
        if (!this.subscribers[gameId]) {
            console.log(`No subscribers for game ${gameId} to publish to.`);
            return;
        }

        console.log(`Publishing to game ${gameId}:`, data.type); // Log type for easier debugging
        const messageString = JSON.stringify(data); // Sérialiser une seule fois

        Object.keys(this.subscribers[gameId]).forEach((subClientId) => { // Itérer sur les clés (clientIds)
            const clientWs = clients[subClientId]; // Récupérer la connexion WebSocket
            // Vérifier si le client est toujours connecté
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                try {
                    clientWs.send(messageString); // Envoyer directement le message
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
                // Peut-être supprimer la partie si finie/abandonnée et vide ?
                // if (games[gameId] && ['finished', 'aborted'].includes(games[gameId].status)) {
                //     delete games[gameId];
                //     console.log(`Game ${gameId} removed (finished/aborted and no subscribers).`);
                // }
            }
        }
    },

    // Helper (moins utilisé mais peut servir)
    getSubscribers: function(gameId) {
        return this.subscribers[gameId] ? Object.keys(this.subscribers[gameId]) : [];
    }
};

// --- Middleware pour vérifier le JWT (exemple) ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- Route pour la connexion via formulaire ---
app.post('/action/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email et mot de passe requis.' });
    }

    try {
        // Récupérer l'utilisateur depuis la base de données en utilisant l'email
        const [rows] = await pool.execute('SELECT id_user, email, password FROM users WHERE email = ?', [email]);
        const user = rows[0];

        if (user) {
            // Comparer le mot de passe fourni avec le mot de passe hashé dans la base de données
            const passwordMatch = await verify(user.password, password);
            // Comparer le mot de passe fourni avec le mot de passe hashé dans la base de données
            // **Important:** Vous devriez utiliser une librairie comme bcrypt pour comparer les mots de passe
            // Ceci est un exemple **INSECURE** et doit être remplacé par une comparaison de hachage appropriée.
            if (passwordMatch) {
                // Générer un JWT
                const token = jwt.sign({ userId: user.id_user, email: user.email }, JWT_SECRET, { expiresIn: '1000000h' }); // Durée d'expiration à adapter

                return res.json({ message: 'Connexion réussie !', token });
            } else {
                return res.status(401).json({ error: 'Mot de passe incorrect.' });
            }
        } else {
            return res.status(404).json({ error: 'Utilisateur non trouvé.' });
        }
    } catch (error) {
        console.error('Erreur lors de la connexion:', error);
        return res.status(500).json({ error: 'Erreur serveur lors de la connexion.' });
    }
});

// --- Route pour l'inscription (sans confirmPassword) ---
app.post('/action/register', [
    // Validation des champs avec express-validator
    body('email')
        .trim()
        .notEmpty()
        .withMessage('L\'adresse email est requise.')
        .isEmail()
        .withMessage('L\'adresse email n\'est pas valide.')
        .isLength({ max: 100 })
        .withMessage('L\'adresse email ne doit pas dépasser 100 caractères.')
        .normalizeEmail(),
    body('password')
        .notEmpty()
        .withMessage('Le mot de passe est requis.')
        .isLength({ min: 6 })
        .withMessage('Le mot de passe doit comporter au moins 6 caractères.'),
], async (req, res) => {
    // Récupérer les erreurs de validation
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
        // Vérifier si l'email existe déjà
        const [existingEmail] = await pool.execute('SELECT email FROM users WHERE email = ?', [email]);
        if (existingEmail.length > 0) {
            return res.status(409).json({ error: 'Cette adresse email est déjà enregistrée.' });
        }

        // Hacher le mot de passe
        const hashedPassword = await hash(password);
        
        // Enregistrer le nouvel utilisateur dans la base de données
        const [result] = await pool.execute(
            'INSERT INTO users (email, password, elo) VALUES (?, ?, ?)',
            [email, hashedPassword, 100]
        );
        
        if (result.insertId) {
            // Récupérer l'ID du nouvel utilisateur
            const userId = result.insertId;

            // Générer un JWT
            const token = jwt.sign({ userId: userId, email: email }, JWT_SECRET, { expiresIn: '1h' }); // Durée d'expiration à adapter

            // Renvoyer le JWT dans la réponse
            return res.status(201).json({ message: 'Inscription réussie !', token });
        } else {
            return res.status(500).json({ error: 'Erreur lors de l\'enregistrement de l\'utilisateur.' });
        }

    } catch (error) {
        console.error('Erreur lors de l\'inscription:', error);
        return res.status(500).json({ error: 'Erreur serveur lors de l\'inscription.' });
    }
});

// --- Route pour récupérer le classement des joueurs ---
app.get('/action/classement', authenticateToken ,async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT email, elo FROM users ORDER BY elo DESC');
        return res.status(200).json(rows);
    } catch (error) {
        console.error('Erreur lors de la récupération du classement:', error);
        return res.status(500).json({ error: 'Erreur serveur lors de la récupération du classement.' });
    }
});

// --- Route pour récupérer les informations de l'utilisateur connecté ---
app.get('/action/userinfo', authenticateToken, async (req, res) => {
    try {
        const userIdFromToken = req.user.userId; // Récupérer l'ID de l'utilisateur depuis le JWT

        const [user] = await pool.execute('SELECT email, elo FROM users WHERE id_user = ?', [userIdFromToken]);

        if (user.length > 0) {
            return res.status(200).json(user[0]); // Renvoie un objet avec email et elo
        } else {
            return res.status(404).json({ error: 'Utilisateur non trouvé.' });
        }
    } catch (error) {
        console.error('Erreur lors de la récupération des informations de l\'utilisateur:', error);
        return res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// --- Gestionnaire de connexion WebSocket ---
wss.on('connection', (ws,req) => {

    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const token = urlParams.get('token');
    if (token) {
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) {
                console.error('Erreur de vérification du JWT:', err);
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Token invalide ou expiré.' }));
                ws.close(1008, 'Token invalide'); // Code 1008 indique une violation de politique
                return;
            }
            // Token valide, attacher les informations de l'utilisateur à l'objet ws
            ws.userId = decoded.userId; // Supposons que votre JWT contient un 'userId'
            console.log(`Client ${ws.userId} (${ws.username}) connecté via WebSocket.`);

        

        });
    } else {
        console.log('Client non authentifié connecté via WebSocket. Connexion non autorisée.');
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Authentification requise.' }));
        ws.close(1008, 'Authentification requise');
        return;
    }
    // Générer un ID client unique
    const clientId = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
    clients[clientId] = ws;
    console.log(`Client ${clientId} connected.`);

    ws.on('message', (message) => {
        let data;
        try {
            // Assurer la conversion en string avant de parser
            data = JSON.parse(message.toString());
        } catch (e) {
            console.error(`Failed parse JSON from ${clientId}:`, message.toString(), e);
            return; // Ignorer le message invalide
        }
        console.log(`Message from ${clientId}:`, data);

        // Ajouter clientId aux données peut être utile dans certains handlers, mais on le passe aussi en argument
        // data.clientId = clientId;

        // Router le message basé sur son type
        switch (data.type) {
            case 'create_game':
                handleCreateGame(clientId, data); // data contient potentiellement gameType
                break;
            case 'join_game':
                handleJoinGame(clientId, data);
                break;
            case 'make_move':
                // Déléguer basé sur le type de jeu stocké sur le serveur
                const gameToMove = games[data.gameId];
                if (gameToMove) {
                    if (gameToMove.gameType === 'puissance4') {
                        handleMakeMovePuissance4(clientId, data);
                    } else { // Défaut ou 'morpion'
                        handleMakeMoveMorpion(clientId, data);
                    }
                } else {
                    console.log(`Move ignored: Game ${data.gameId} not found for client ${clientId}.`);
                    // Informer le client?
                    if (clients[clientId]?.readyState === WebSocket.OPEN) {
                        clients[clientId].send(JSON.stringify({ type: 'error', message: 'Partie introuvable pour effectuer le coup.' }));
                    }
                }
                break;
            case 'request_replay':
                handleRequestReplay(clientId, data);
                break;
            case 'send_message':
                handleSendMessage(clientId, data); // Le chat est générique
                break;
            default:
                console.log(`Unrecognized message type from ${clientId}:`, data.type);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', message: `Type de message inconnu reçu: ${data.type}` }));
                }
        }
    });

    ws.on('close', (code, reason) => {
        // Nettoyer quand un client se déconnecte
        console.log(`Client ${clientId} disconnected. Code: ${code}, Reason: ${reason?.toString()}`);
        handleDisconnect(clientId); // Gérer l'impact sur les jeux en cours
        delete clients[clientId]; // Supprimer la référence client
    });

    ws.on('error', (error) => {
        // Gérer les erreurs de connexion
        console.error(`WebSocket Error for client ${clientId}:`, error);
        handleDisconnect(clientId); // Gérer aussi comme une déconnexion
        delete clients[clientId];
        // La connexion se ferme généralement après une erreur, 'close' sera aussi appelé
    });

    // Envoyer l'ID client après connexion réussie
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'connected', clientId }));
    }
});


// --- Fonctions de gestion de jeu ---

/**
 * Crée une nouvelle partie (Morpion ou Puissance 4).
 * @param {string} clientId - ID du client créateur.
 * @param {object} data - Données reçues ({ type: 'create_game', gameType?: 'morpion'|'puissance4' }).
 */
function handleCreateGame(clientId, data) {
    const gameId = generateGameId();
    // Défaut à 'morpion' si gameType n'est pas fourni ou invalide
    const gameType = ['morpion', 'puissance4'].includes(data.gameType) ? data.gameType : 'morpion';

    console.log(`Attempting to create game type: ${gameType} by ${clientId}`);

    let newGame;

    // Initialiser la structure du jeu basée sur le type
    if (gameType === 'puissance4') {
        newGame = {
            id: gameId,
            gameType: 'puissance4',
            board: Array(P4_BOARD_SIZE).fill(null), // Grille 6x7 vide
            players: { R: clientId, J: null }, // Joueur Rouge (créateur), Joueur Jaune (null)
            playerSymbols: { [clientId]: 'R' }, // Map clientId -> symbole ('R' ou 'J')
            currentTurn: 'R', // Rouge commence toujours
            starter: 'R', // Qui a commencé cette manche (pour alterner au replay)
            status: 'waiting', // 'waiting', 'playing', 'finished', 'aborted'
            replayRequestedBy: new Set(), // IDs des clients voulant rejouer
            winningLine: null // Stockera les indices des jetons gagnants
        };
    } else { // Morpion (par défaut)
        newGame = {
            id: gameId,
            gameType: 'morpion',
            board: Array(9).fill(null), // Grille 3x3 vide
            players: { X: clientId, O: null }, // Joueur X (créateur), Joueur O (null)
            playerSymbols: { [clientId]: 'X' }, // Map clientId -> symbole ('X' ou 'O')
            currentTurn: 'X', // X commence toujours
            starter: 'X',
            status: 'waiting',
            replayRequestedBy: new Set(),
            winner: null // Sera 'X', 'O', ou null (nul)
        };
    }

    games[gameId] = newGame; // Enregistrer la nouvelle partie

    // Abonner le créateur aux mises à jour de sa partie
    PubSub.subscribe(gameId, clientId, () => {}); // Le callback ici est symbolique

    // Notifier le créateur du succès et de l'état initial
    PubSub.publish(gameId, {
        type: 'game_created',
        gameId,
        game: games[gameId] // Envoyer l'objet jeu complet
    });
    console.log(`Game <span class="math-inline">\{gameId\} \(</span>{gameType}) created by ${clientId}. Waiting for opponent.`);
}

/**
 * Permet à un client de rejoindre une partie existante.
 * @param {string} clientId - ID du client qui rejoint.
 * @param {object} data - Données reçues ({ type: 'join_game', gameId: '...' }).
 */
function handleJoinGame(clientId, data) {
    const { gameId } = data;
    const game = games[gameId];
    const clientWs = clients[clientId]; // Référence WebSocket du client

    // Vérifier si le client est toujours connecté
    if (!clientWs || clientWs.readyState !== WebSocket.OPEN) {
        console.log(`Join attempt ignored: Client ${clientId} is not connected.`);
        return;
    }

    // Vérifier si la partie existe
    if (!game) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Partie introuvable.' }));
        console.log(`Join attempt failed: Game ${gameId} not found for client ${clientId}.`);
        return;
    }

    let opponentSymbol;
    let playerSlotFull = false;
    let isOwnGame = false;

    // Déterminer le symbole de l'adversaire et vérifier si la place est libre / si c'est sa propre partie
    if (game.gameType === 'puissance4') {
        opponentSymbol = 'J'; // Le joueur qui rejoint est Jaune ('J')
        playerSlotFull = game.players.J !== null;
        isOwnGame = game.players.R === clientId;
    } else { // Morpion
        opponentSymbol = 'O';
        playerSlotFull = game.players.O !== null;
        isOwnGame = game.players.X === clientId;
    }

    // Vérifier si la partie est déjà pleine
    if (playerSlotFull) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Cette partie est déjà complète.' }));
        console.log(`Join attempt failed: Game <span class="math-inline">\{gameId\} \(</span>{game.gameType}) is full. Client ${clientId} rejected.`);
        return;
    }

    // Vérifier si le joueur essaie de rejoindre sa propre partie
    if (isOwnGame) {
        const ownSymbol = game.gameType === 'puissance4' ? 'Rouge' : 'X';
        clientWs.send(JSON.stringify({ type: 'error', message: `Vous êtes déjà le joueur ${ownSymbol} dans cette partie.` }));
        console.log(`Join attempt failed: Client ${clientId} is already the first player in game ${gameId}.`);
        return;
    }

     // Vérifier si la partie n'est pas déjà en cours ou terminée (double sécurité)
     if (game.status !== 'waiting') {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Impossible de rejoindre une partie déjà commencée ou terminée.' }));
        console.log(`Join attempt failed: Game <span class="math-inline">\{gameId\} status is '</span>{game.status}'. Client ${clientId} rejected.`);
        return;
    }


    // Ajouter le second joueur
    game.players[opponentSymbol] = clientId;
    game.playerSymbols[clientId] = opponentSymbol;
    game.status = 'playing'; // La partie commence !
    game.replayRequestedBy.clear(); // Vider les demandes de replay au début d'une partie

    // Abonner le nouveau joueur
    PubSub.subscribe(gameId, clientId, () => {});

    // Notifier les deux joueurs que la partie commence et envoyer l'état
    PubSub.publish(gameId, {
        type: 'game_started',
        game // Envoyer l'état complet mis à jour
    });
    console.log(`Client ${clientId} joined game <span class="math-inline">\{gameId\} \(</span>{game.gameType}) as Player ${opponentSymbol}. Game started.`);
}

// --- Logique Spécifique au Morpion ---

/**
 * Gère un coup joué au Morpion.
 * @param {string} clientId - ID du joueur.
 * @param {object} data - Données ({ gameId: '...', position: 0-8 }).
 */
async function handleMakeMoveMorpion(clientId, data) { // Ajout de 'async'
    const { gameId, position } = data;
    const game = games[gameId];

    // --- Validations Robustes ---
    if (!game || game.gameType !== 'morpion') { console.log(`Morpion move ignored: Game ${gameId} not found or not morpion.`); return; }
    const playerSymbol = game.playerSymbols[clientId];
    if (!playerSymbol) { console.log(`Morpion move ignored: Client ${clientId} not in game ${gameId}.`); return; }
    if (game.status !== 'playing') { console.log(`Morpion move ignored: Game ${gameId} status is ${game.status}.`); return; }
    if (game.currentTurn !== playerSymbol) { console.log(`Morpion move ignored: Not ${playerSymbol}'s turn in ${gameId}.`); return; }
    if (position === undefined || position < 0 || position > 8 || !Number.isInteger(position)) { console.log(`Morpion move ignored: Invalid position ${position}.`); return; }
    if (game.board[position] !== null) { console.log(`Morpion move ignored: Position ${position} already taken.`); return; }
    // --- Fin Validations ---

    // Effectuer le coup
    game.board[position] = playerSymbol;
    console.log(`Morpion move by ${clientId} (${playerSymbol}) at ${position} in ${gameId}.`);

    // Vérifier l'issue
    const winner = checkWinnerMorpion(game.board);
    const isDraw = !winner && !game.board.includes(null);

    if (winner) {
        game.status = 'finished';
        game.winner = winner;
        console.log(`Morpion game ${gameId} finished. Winner: ${winner}`);

        // --- Logique de mise à jour de l'ELO pour le Morpion ---
        const winnerClientId = Object.keys(game.playerSymbols).find(key => game.playerSymbols[key] === winner);
        const loserClientId = Object.keys(game.playerSymbols).find(key => game.playerSymbols[key] !== winner);

        const winnerWs = clients[winnerClientId];
        const loserWs = clients[loserClientId];

        if (winnerWs && winnerWs.userId) {
            try {
                await pool.execute('UPDATE users SET elo = elo + 10 WHERE id_user = ?', [winnerWs.userId]);
                console.log(`ELO updated: +10 for winner ${winnerWs.userId}`);
            } catch (e) {
                console.error(`Error updating ELO for winner ${winnerWs.userId}:`, e);
            }
        }
        if (loserWs && loserWs.userId) {
            try {
                await pool.execute('UPDATE users SET elo = elo - 10 WHERE id_user = ?', [loserWs.userId]);
                console.log(`ELO updated: -10 for loser ${loserWs.userId}`);
            } catch (e) {
                console.error(`Error updating ELO for loser ${loserWs.userId}:`, e);
            }
        }
        // --- Fin Logique ELO ---

        PubSub.publish(gameId, { type: 'game_over', game, winner });
    } else if (isDraw) {
        game.status = 'finished';
        game.winner = null;
        console.log(`Morpion game ${gameId} finished. Draw.`);
        PubSub.publish(gameId, { type: 'game_over', game, winner: null });
    } else {
        // La partie continue, changer de joueur
        game.currentTurn = game.currentTurn === 'X' ? 'O' : 'X';
        PubSub.publish(gameId, { type: 'move_made', game });
    }
}
/**
 * Vérifie s'il y a un gagnant au Morpion.
 * @param {Array<string|null>} board - Le tableau de jeu 1D (taille 9).
 * @returns {string|null} 'X', 'O', ou null s'il n'y a pas de gagnant.
 */
function checkWinnerMorpion(board) {
    const winPatterns = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], // Lignes
        [0, 3, 6], [1, 4, 7], [2, 5, 8], // Colonnes
        [0, 4, 8], [2, 4, 6]             // Diagonales
    ];
    for (const pattern of winPatterns) {
        const [a, b, c] = pattern;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return board[a]; // Retourne 'X' ou 'O'
        }
    }
    return null; // Pas de gagnant
}

// --- Logique Spécifique au Puissance 4 ---

/**
 * Gère un coup joué au Puissance 4.
 * @param {string} clientId - ID du joueur.
 * @param {object} data - Données ({ gameId: '...', column: 0-6 }).
 */
async function handleMakeMovePuissance4(clientId, data) { // Ajout de 'async'
    const { gameId, column } = data; // Le client envoie l'index de la colonne (0-6)
    const game = games[gameId];

    // --- Validations Robustes ---
    if (!game || game.gameType !== 'puissance4') { console.log(`P4 move ignored: Game ${gameId} not found or not P4.`); return; }
    const playerSymbol = game.playerSymbols[clientId]; // 'R' ou 'J'
    if (!playerSymbol) { console.log(`P4 move ignored: Client ${clientId} not in game ${gameId}.`); return; }
    if (game.status !== 'playing') { console.log(`P4 move ignored: Game ${gameId} status is ${game.status}.`); return; }
    if (game.currentTurn !== playerSymbol) { console.log(`P4 move ignored: Not ${playerSymbol}'s turn in ${gameId}.`); return; }
    if (column === undefined || column < 0 || column >= P4_COLUMNS || !Number.isInteger(column)) { console.log(`P4 move ignored: Invalid column ${column}.`); return; }
    // --- Fin Validations ---

    // Trouver la rangée vide la plus basse dans la colonne choisie
    let targetRow = -1;
    for (let row = P4_ROWS - 1; row >= 0; row--) {
        const index = row * P4_COLUMNS + column;
        if (game.board[index] === null) {
            targetRow = row; // Rangée trouvée
            break;
        }
    }

    // Vérifier si la colonne est pleine
    if (targetRow === -1) {
        console.log(`P4 move ignored: Column ${column} is full in game ${gameId}.`);
        // Informer le client (optionnel mais recommandé)
        if (clients[clientId]?.readyState === WebSocket.OPEN) {
            clients[clientId].send(JSON.stringify({ type: 'error', message: `La colonne ${column + 1} est pleine.` }));
        }
        return;
    }

    // Effectuer le coup
    const targetIndex = targetRow * P4_COLUMNS + column;
    game.board[targetIndex] = playerSymbol;
    console.log(`P4 move by ${clientId} (${playerSymbol}) in col ${column} (row ${targetRow}, index ${targetIndex}) in ${gameId}.`);

    // Vérifier l'issue du jeu
    const winCheckResult = checkWinnerPuissance4(game.board, playerSymbol, targetIndex);

    if (winCheckResult) { // Si un gagnant est trouvé
        game.status = 'finished';
        game.winner = playerSymbol; // Le joueur courant a gagné
        game.winningLine = winCheckResult; // Stocker les indices gagnants
        console.log(`P4 game ${gameId} finished. Winner: ${playerSymbol}. Line: [${winCheckResult.join(', ')}]`);

        // --- Logique de mise à jour de l'ELO pour Puissance 4 ---
        const winnerClientId = Object.keys(game.playerSymbols).find(key => game.playerSymbols[key] === playerSymbol);
        const loserClientId = Object.keys(game.playerSymbols).find(key => game.playerSymbols[key] !== playerSymbol);

        const winnerWs = clients[winnerClientId];
        const loserWs = clients[loserClientId];

        if (winnerWs && winnerWs.userId) {
            try {
                await pool.execute('UPDATE users SET elo = elo + 10 WHERE id_user = ?', [winnerWs.userId]);
                console.log(`ELO updated: +10 for winner ${winnerWs.userId}`);
            } catch (e) {
                console.error(`Error updating ELO for winner ${winnerWs.userId}:`, e);
            }
        }
        if (loserWs && loserWs.userId) {
            try {
                await pool.execute('UPDATE users SET elo = elo - 10 WHERE id_user = ?', [loserWs.userId]);
                console.log(`ELO updated: -10 for loser ${loserWs.userId}`);
            } catch (e) {
                console.error(`Error updating ELO for loser ${loserWs.userId}:`, e);
            }
        }
        // --- Fin Logique ELO ---

        PubSub.publish(gameId, { type: 'game_over', game, winner: playerSymbol, winningLine: winCheckResult });
    } else if (!game.board.includes(null)) { // Vérifier si match nul (plateau plein, pas de gagnant)
        game.status = 'finished';
        game.winner = null;
        console.log(`P4 game ${gameId} finished. Draw.`);
        PubSub.publish(gameId, { type: 'game_over', game, winner: null });
    } else {
        // La partie continue, changer de joueur
        game.currentTurn = game.currentTurn === 'R' ? 'J' : 'R';
        PubSub.publish(gameId, { type: 'move_made', game });
    }
}

/**
 * Vérifie s'il y a un gagnant au Puissance 4 après un coup.
 * @param {Array<string|null>} board - Le tableau de jeu 1D (taille 42).
 * @param {string} playerSymbol - Le symbole du joueur qui vient de jouer ('R' ou 'J').
 * @param {number} lastMoveIndex - L'index du dernier jeton posé.
 * @returns {Array<number>|null} Un tableau contenant les 4 indices gagnants, ou null.
 */
function checkWinnerPuissance4(board, playerSymbol, lastMoveIndex) {
    const col = lastMoveIndex % P4_COLUMNS;
    const row = Math.floor(lastMoveIndex / P4_COLUMNS);
    const numRows = P4_ROWS;
    const numCols = P4_COLUMNS;

    // Fonction interne pour vérifier une ligne dans une direction donnée
    function checkDirection(dx, dy) {
        let line = [lastMoveIndex]; // Commence avec le dernier coup joué
        // Vérifie dans la direction positive (dx, dy)
        for (let i = 1; i < 4; i++) {
            const nextRow = row + i * dy;
            const nextCol = col + i * dx;
            const nextIndex = nextRow * numCols + nextCol;
            // Vérifie les limites et si le jeton appartient au joueur
            if (nextRow >= 0 && nextRow < numRows && nextCol >= 0 && nextCol < numCols && board[nextIndex] === playerSymbol) {
                line.push(nextIndex);
            } else {
                break; // Arrête si hors limites ou jeton différent/vide
            }
        }
        // Vérifie dans la direction négative (-dx, -dy)
        for (let i = 1; i < 4; i++) {
            const nextRow = row - i * dy;
            const nextCol = col - i * dx;
            const nextIndex = nextRow * numCols + nextCol;
            if (nextRow >= 0 && nextRow < numRows && nextCol >= 0 && nextCol < numCols && board[nextIndex] === playerSymbol) {
                line.push(nextIndex);
            } else {
                break;
            }
        }
        // Si la ligne contient au moins 4 jetons, c'est gagné
        return line.length >= 4 ? line.sort((a, b) => a - b) : null; // Retourne les indices triés si gagné
    }

    // Vérifie les 4 directions possibles
    const horizontal = checkDirection(1, 0);    // Droite/Gauche
    if (horizontal) return horizontal;
    const vertical = checkDirection(0, 1);      // Bas/Haut (on vérifie depuis le bas)
    if (vertical) return vertical;
    const diagDownRight = checkDirection(1, 1); // Diagonale Bas-Droite / Haut-Gauche
    if (diagDownRight) return diagDownRight;
    const diagUpRight = checkDirection(1, -1);  // Diagonale Haut-Droite / Bas-Gauche
    if (diagUpRight) return diagUpRight;

    return null; // Pas de gagnant trouvé
}


// --- Handlers Génériques (Chat, Replay, Déconnexion) ---

/**
 * Gère une demande de rejouer d'un client.
 * @param {string} clientId - ID du client demandeur.
 * @param {object} data - Données ({ gameId: '...' }).
 */
function handleRequestReplay(clientId, data) {
    const { gameId } = data;
    const game = games[gameId];

    // Validations
    if (!game) { console.log(`Replay request ignored: Game ${gameId} not found.`); return; }
    if (game.status !== 'finished') { console.log(`Replay request ignored: Game ${gameId} not finished (${game.status}).`); return; }
    if (!game.playerSymbols[clientId]) { console.log(`Replay request ignored: Client ${clientId} not in game ${gameId}.`); return; }

    // Enregistrer la demande
    game.replayRequestedBy.add(clientId);
    console.log(`Replay requested by ${clientId} for ${gameId}. Total requests: ${game.replayRequestedBy.size}`);

    // Notifier le demandeur (accusé de réception)
    const clientWs = clients[clientId];
    if (clientWs?.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'replay_request_acknowledged', gameId }));
    }

    // Vérifier si tous les joueurs ont demandé
    const playerIds = Object.values(game.players).filter(id => id !== null); // Obtenir les IDs des joueurs présents
    if (playerIds.length === 2 && game.replayRequestedBy.size === 2) {
        // Les deux joueurs veulent rejouer
        console.log(`Both players (${playerIds.join(', ')}) requested replay for game ${gameId}. Resetting...`);
        resetGame(gameId); // Réinitialiser la partie
    } else if (playerIds.length === 2) {
        // Informer l'autre joueur de la demande (s'il n'a pas déjà demandé)
        const opponentId = playerIds.find(id => id !== clientId);
        if (opponentId && !game.replayRequestedBy.has(opponentId)) {
            const opponentWs = clients[opponentId];
            if (opponentWs?.readyState === WebSocket.OPEN) {
                opponentWs.send(JSON.stringify({
                    type: 'replay_requested',
                    gameId,
                    requesterId: clientId
                }));
                console.log(`Notified opponent ${opponentId} about replay request from ${clientId} for game ${gameId}.`);
            }
        }
    } else {
        // Cas où il n'y a pas (encore) deux joueurs (ne devrait pas arriver si status='finished' mais sécurité)
        console.log(`Replay request by ${clientId} for ${gameId}, but only ${playerIds.length} player(s) present.`);
    }
}

/**
 * Gère l'envoi d'un message de chat.
 * @param {string} clientId - ID de l'expéditeur.
 * @param {object} data - Données ({ gameId: '...', message: '...' }).
 */
function handleSendMessage(clientId, data) {
    const { gameId, message } = data;
    const game = games[gameId];

    // Validations
    if (!game) { console.log(`Chat ignored: Game ${gameId} not found.`); return; }
    const playerSymbol = game.playerSymbols[clientId];
    if (!playerSymbol) { console.log(`Chat ignored: Client ${clientId} not in game ${gameId}.`); return; }
    // Autoriser le chat même si la partie est finie? Oui. Si abandonnée? Non.
    if (game.status === 'aborted') { console.log(`Chat ignored: Game ${gameId} is aborted.`); return;}
    if (!message || typeof message !== 'string' || message.trim().length === 0) { console.log(`Chat ignored: Empty message from ${clientId}.`); return; }

    // Nettoyer et limiter la taille
    const cleanMessage = message.trim().substring(0, 250);

    console.log(`[Chat ${gameId}] ${playerSymbol} (${clientId}): ${cleanMessage}`);

    // Diffuser le message via PubSub
    PubSub.publish(gameId, {
        type: 'chat_message',
        gameId: gameId,
        senderSymbol: playerSymbol,
        message: cleanMessage
    });
}

/**
 * Réinitialise une partie pour une nouvelle manche (après accord de replay).
 * @param {string} gameId - ID de la partie à réinitialiser.
 */
function resetGame(gameId) {
    const game = games[gameId];
    if (!game) { console.error(`Cannot reset game ${gameId}: Not found.`); return; }
    console.log(`Resetting game ${gameId} (${game.gameType})...`);

    // Déterminer les symboles des joueurs 1 et 2 pour ce type de jeu
    let P1Symbol, P2Symbol;
    if (game.gameType === 'puissance4') { P1Symbol = 'R'; P2Symbol = 'J'; }
    else { P1Symbol = 'X'; P2Symbol = 'O'; }

    // Alterner le joueur qui commence
    game.starter = game.starter === P1Symbol ? P2Symbol : P1Symbol;
    game.currentTurn = game.starter;

    // Réinitialiser le plateau selon le type
    game.board = game.gameType === 'puissance4' ? Array(P4_BOARD_SIZE).fill(null) : Array(9).fill(null);
    game.status = 'playing'; // Prêt à jouer
    delete game.winner;      // Effacer le gagnant précédent
    delete game.winningLine; // Effacer la ligne gagnante précédente (P4)
    game.replayRequestedBy.clear(); // Vider les demandes de replay

    // Notifier les joueurs que la nouvelle manche commence
    PubSub.publish(gameId, {
        type: 'game_started', // Réutiliser ce type pour envoyer le nouvel état initial
        game
    });
    console.log(`Game ${gameId} reset. New round started. ${game.currentTurn} begins.`);
}

/**
 * Génère un ID de partie court et aléatoire.
 * @returns {string} L'ID de partie généré.
 */
function generateGameId() {
    // Simple générateur d'ID (suffisant pour ce projet)
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Gère la déconnexion d'un client, met à jour l'état de la partie affectée.
 * @param {string} clientId - ID du client déconnecté.
 */
function handleDisconnect(clientId) {
    console.log(`Handling disconnect for client ${clientId}...`);
    let gameFoundId = null;
    let gameFound = null;

    // Trouver la partie où le client jouait
    for (const gameId in games) {
        const game = games[gameId];
        // Vérifier si le clientId est l'un des joueurs de la partie
        if (Object.values(game.players).includes(clientId)) {
            gameFoundId = gameId;
            gameFound = game;
            break; // Un client ne peut être que dans une partie à la fois
        }
    }

    if (gameFound) {
        console.log(`Client ${clientId} was in game ${gameFoundId} (${gameFound.gameType}).`);
        // 1. Désabonner le joueur déconnecté des mises à jour de cette partie
        PubSub.unsubscribe(gameFoundId, clientId);

        // 2. Gérer l'impact sur l'état de la partie
        const opponentId = Object.values(gameFound.players).find(id => id && id !== clientId);

        if (gameFound.status === 'waiting') {
            // Si la partie attendait et que c'est le créateur (P1) qui part
            const isCreator = (gameFound.gameType === 'morpion' && gameFound.players.X === clientId) ||
                              (gameFound.gameType === 'puissance4' && gameFound.players.R === clientId);
            if (isCreator) {
                console.log(`Game ${gameFoundId} aborted (creator ${clientId} disconnected while waiting).`);
                // La partie ne peut pas continuer, on la supprime
                delete games[gameFoundId];
                // Assurer que les abonnements sont aussi supprimés (unsubscribe le fait déjà s'il ne reste personne)
                delete PubSub.subscribers[gameFoundId];
            } else {
                // Si c'est le joueur 2 qui part pendant l'attente (très improbable mais géré)
                console.warn(`Player 2 (${clientId}) disconnected while game ${gameFoundId} was waiting? Resetting P2 slot.`);
                const opponentSlot = gameFound.gameType === 'morpion' ? 'O' : 'J';
                gameFound.players[opponentSlot] = null; // Libérer la place
                delete gameFound.playerSymbols[clientId]; // Retirer son symbole
                // La partie reste en 'waiting'
            }
        } else if (opponentId && (gameFound.status === 'playing' || gameFound.status === 'finished')) {
            // Si la partie était en cours ou finie et qu'il y avait un adversaire
            console.log(`Notifying opponent ${opponentId} about disconnection of ${clientId} in game ${gameFoundId}.`);
            gameFound.status = 'aborted'; // Marquer la partie comme abandonnée
            delete gameFound.winner;
            delete gameFound.winningLine;
            gameFound.replayRequestedBy.clear(); // Annuler les demandes de replay

            // Notifier l'adversaire resté en ligne (s'il est connecté)
            const opponentWs = clients[opponentId];
            if (opponentWs?.readyState === WebSocket.OPEN) {
                opponentWs.send(JSON.stringify({
                    type: 'opponent_disconnected',
                    gameId: gameFoundId,
                    disconnectedPlayerId: clientId, // Informer qui est parti
                    message: 'Votre adversaire s\'est déconnecté. La partie est terminée.'
                }));
                // Optionnel: Désabonner aussi l'adversaire car la partie est finie pour lui aussi
                // PubSub.unsubscribe(gameFoundId, opponentId);
            }
            // Conserver la partie comme 'aborted' ou la supprimer après un délai ? On la conserve pour l'instant.
        } else if (!opponentId && (gameFound.status === 'finished' || gameFound.status === 'aborted')) {
            // Si le jeu était fini/abandonné et que le dernier joueur se déconnecte
            console.log(`Last player ${clientId} disconnected from finished/aborted game ${gameFoundId}. Cleaning up game.`);
             delete games[gameFoundId];
             delete PubSub.subscribers[gameFoundId];
        }
         // Autres cas (ex: partie en cours sans adversaire? Ne devrait pas arriver)

    } else {
        console.log(`Client ${clientId} was not found in any active game.`);
    }
}



// --- Démarrer le serveur ---
const PORT = process.env.PORT || 1111; // Utiliser variable d'environnement si définie, sinon 1111
server.listen(PORT, () => {
    console.log(`Multi-Game WebSocket Server started on port ${PORT}`);
    console.log(`Access the game selection via http://localhost:${PORT}`); // ou votre IP/domaine
});