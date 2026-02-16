const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game state
const gameState = {
    settings: {
        numTeams: 7,
        maxPlayers: 3,
        minTeams: 1,
        speedCoef: 1,
        baseSpeed: 1000 / 330
    },
    teams: {},
    players: {},
    gameStatus: 'registration', // registration, racing, finished
    raceStartTime: null,
    winner: null
};

// Initialize teams
function initializeTeams() {
    gameState.teams = {};
    for (let i = 1; i <= gameState.settings.numTeams; i++) {
        gameState.teams[i] = {
            id: i,
            name: '',
            players: [],
            position: 0,
            shakeIntensity: 0
        };
    }
}

initializeTeams();

// Connected clients
const clients = new Map(); // playerId -> WebSocket
const displayClients = new Set(); // Display screens
const adminClients = new Set(); // Admin panels

// Broadcast to all clients
function broadcast(message) {
    const data = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Broadcast to display screens only
function broadcastToDisplays(message) {
    const data = JSON.stringify(message);
    displayClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Broadcast to players only
function broadcastToPlayers(message) {
    const data = JSON.stringify(message);
    clients.forEach((client, playerId) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    
    let clientType = null;
    let playerId = null;

    ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                // НОВОЕ: Если игрок запрашивает состояние
                if (data.type === 'request_state' && clientType === null) {
                    ws.send(JSON.stringify({
                        type: 'game_state',
                        state: gameState
                    }));
                    return;
                }
            
            switch (data.type) {
                case 'register_display':
                    clientType = 'display';
                    displayClients.add(ws);
                    ws.send(JSON.stringify({
                        type: 'game_state',
                        state: gameState
                    }));
                    console.log('Display registered');
                    break;

                case 'register_admin':
                    clientType = 'admin';
                    adminClients.add(ws);
                    ws.send(JSON.stringify({
                        type: 'game_state',
                        state: gameState
                    }));
                    console.log('Admin registered');
                    break;

                case 'register_player':
                    const { teamId, teamName } = data;
                    const team = gameState.teams[teamId];
                    
                    if (!team) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid team' }));
                        return;
                    }

                    if (team.players.length >= gameState.settings.maxPlayers) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Team is full' }));
                        return;
                    }

                    // Set team name if first player
                    if (team.players.length === 0 && teamName) {
                        team.name = teamName;
                    }

                    // Create player
                    playerId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
                    clientType = 'player';
                    
                    gameState.players[playerId] = {
                        id: playerId,
                        teamId: teamId,
                        shakeIntensity: 0,
                        lastShake: Date.now()
                    };

                    team.players.push(playerId);
                    clients.set(playerId, ws);

                    ws.send(JSON.stringify({
                        type: 'player_registered',
                        playerId: playerId,
                        teamId: teamId,
                        teamName: team.name
                    }));

                    // Broadcast updated state
                    broadcast({
                        type: 'game_state',
                        state: gameState
                    });

                    console.log(`Player ${playerId} registered to team ${teamId}`);
                    break;

                case 'update_shake':
                    if (playerId && gameState.players[playerId]) {
                        const { intensity } = data;
                        gameState.players[playerId].shakeIntensity = intensity;
                        gameState.players[playerId].lastShake = Date.now();
                    }
                    break;

                case 'start_race':
                    if (clientType === 'admin' || clientType === 'display') {
                        const registeredCount = Object.values(gameState.teams)
                            .filter(t => t.players.length > 0).length;
                        
                        if (registeredCount >= gameState.settings.minTeams) {
                            gameState.gameStatus = 'racing';
                            gameState.raceStartTime = Date.now();
                            gameState.winner = null;
                            
                            // Reset positions
                            Object.values(gameState.teams).forEach(team => {
                                team.position = 0;
                                team.shakeIntensity = 0;
                            });

                            broadcast({
                                type: 'race_started',
                                state: gameState
                            });
                            
                            console.log('Race started');
                        }
                    }
                    break;

                case 'update_settings':
                    if (clientType === 'admin') {
                        const { numTeams, maxPlayers, minTeams, speedCoef } = data;
                        
                        if (numTeams) gameState.settings.numTeams = numTeams;
                        if (maxPlayers) gameState.settings.maxPlayers = maxPlayers;
                        if (minTeams) gameState.settings.minTeams = minTeams;
                        if (speedCoef) gameState.settings.speedCoef = speedCoef;

                        initializeTeams();

                        broadcast({
                            type: 'settings_updated',
                            state: gameState
                        });
                        
                        console.log('Settings updated');
                    }
                    break;

                case 'reset_game':
                    if (clientType === 'admin' || clientType === 'display') {
                        gameState.gameStatus = 'registration';
                        gameState.raceStartTime = null;
                        gameState.winner = null;
                        gameState.players = {};
                        
                        // Очистить всех игроков
                        clients.clear();
                        
                        initializeTeams();

                        // Отправить ВСЕМ клиентам
                        broadcast({
                            type: 'game_reset',
                            state: gameState
                        });
                        
                        console.log('Game reset - all players disconnected');
                    }
                    break;
            }
        } catch (error) {
            console.error('Error handling message:', error);
            ws.send(JSON.stringify({ type: 'error', message: 'Server error' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        
        if (clientType === 'display') {
            displayClients.delete(ws);
        } else if (clientType === 'admin') {
            adminClients.delete(ws);
        } else if (clientType === 'player' && playerId) {
            // Remove player
            const player = gameState.players[playerId];
            if (player) {
                const team = gameState.teams[player.teamId];
                if (team) {
                    team.players = team.players.filter(id => id !== playerId);
                }
                delete gameState.players[playerId];
            }
            clients.delete(playerId);

            // Broadcast updated state
            broadcast({
                type: 'game_state',
                state: gameState
            });
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Game loop - update race positions
setInterval(() => {
    if (gameState.gameStatus === 'racing') {
        const activeTeams = Object.values(gameState.teams).filter(t => t.players.length > 0);
        const trackWidth = 1000; // Virtual track width
        
        let hasWinner = false;

        activeTeams.forEach(team => {
            // Calculate team shake intensity
            let totalIntensity = 0;
            team.players.forEach(playerId => {
                const player = gameState.players[playerId];
                if (player) {
                    totalIntensity += player.shakeIntensity;
                }
            });
            
            team.shakeIntensity = totalIntensity;
            
            // Update position
            const speed = totalIntensity * gameState.settings.speedCoef * gameState.settings.baseSpeed;
            team.position += speed * 0.05; // 50ms interval
            
            // Check winner
            if (team.position >= trackWidth && !gameState.winner) {
                gameState.winner = team;
                gameState.gameStatus = 'finished';
                hasWinner = true;
            }
        });

        // Broadcast race update
        broadcastToDisplays({
            type: 'race_update',
            teams: activeTeams.map(t => ({
                id: t.id,
                name: t.name,
                position: t.position,
                shakeIntensity: t.shakeIntensity,
                playerCount: t.players.length
            })),
            winner: gameState.winner ? gameState.winner.id : null
        });

        if (hasWinner) {
            broadcast({
                type: 'race_finished',
                winner: gameState.winner
            });
            console.log(`Race finished! Winner: ${gameState.winner.name}`);
        }
    }

    // Decay shake intensity
    const now = Date.now();
    Object.values(gameState.players).forEach(player => {
        if (now - player.lastShake > 200) {
            player.shakeIntensity = Math.max(0, player.shakeIntensity - 0.5);
        }
    });
}, 50);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server is running`);
});
