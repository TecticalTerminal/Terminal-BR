import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { GameState } from '@tactical/shared-types';
import { WebSocketServer, WebSocket } from 'ws';

type SnapshotLoader = (gameId: string) => Promise<{ seq: number; state: GameState }>;

type WsMessage =
  | { type: 'state_snapshot'; payload: { gameId: string; seq: number; state: GameState } }
  | { type: 'action_applied'; payload: unknown }
  | { type: 'game_over'; payload: unknown }
  | { type: 'error'; payload: { message: string } };

function send(socket: WebSocket, message: WsMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export class RealtimeHub {
  private readonly wsServer: WebSocketServer;
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly loadSnapshot: SnapshotLoader;

  constructor(loadSnapshot: SnapshotLoader) {
    this.loadSnapshot = loadSnapshot;
    this.wsServer = new WebSocketServer({ noServer: true });
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const gameId = url.searchParams.get('gameId');
    if (!gameId) {
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, async (ws) => {
      await this.joinRoom(gameId, ws);
    });
  }

  private async joinRoom(gameId: string, socket: WebSocket) {
    if (!this.rooms.has(gameId)) {
      this.rooms.set(gameId, new Set());
    }
    this.rooms.get(gameId)!.add(socket);

    try {
      const snapshot = await this.loadSnapshot(gameId);
      send(socket, {
        type: 'state_snapshot',
        payload: {
          gameId,
          seq: snapshot.seq,
          state: snapshot.state
        }
      });
    } catch {
      send(socket, {
        type: 'error',
        payload: { message: 'Failed to load game snapshot.' }
      });
    }

    socket.on('close', () => {
      const room = this.rooms.get(gameId);
      room?.delete(socket);
      if (room && room.size === 0) {
        this.rooms.delete(gameId);
      }
    });
  }

  broadcastAction(gameId: string, payload: unknown) {
    this.broadcast(gameId, { type: 'action_applied', payload });
  }

  broadcastGameOver(gameId: string, payload: unknown) {
    this.broadcast(gameId, { type: 'game_over', payload });
  }

  private broadcast(gameId: string, message: WsMessage) {
    const sockets = this.rooms.get(gameId);
    if (!sockets || sockets.size === 0) return;
    for (const socket of sockets) {
      send(socket, message);
    }
  }
}
