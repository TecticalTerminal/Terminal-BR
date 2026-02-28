import { env } from '../config.js';
import { getGame } from '../games/repository.js';
import { HttpError } from '../utils/http-error.js';
import { CastMarketClient } from './cast-client.js';
import {
  createOrUpdateRoundOpened,
  getGameRoundMapping,
  markRoundFailed,
  markRoundResolved,
  type GameRoundMapping
} from './repository.js';

export interface MarketService {
  readonly enabled: boolean;
  openRoundForGame(input: { gameId: string; lockSeconds?: number }): Promise<GameRoundMapping>;
  resolveRoundForGame(input: {
    gameId: string;
    winnerPlayerId?: string;
    skipIfNotOpened?: boolean;
  }): Promise<GameRoundMapping | null>;
  getMapping(gameId: string): Promise<GameRoundMapping | null>;
}

class DisabledMarketService implements MarketService {
  readonly enabled = false;

  private unavailable(): never {
    throw new HttpError(503, 'Market integration is disabled.');
  }

  async openRoundForGame(): Promise<GameRoundMapping> {
    this.unavailable();
  }

  async resolveRoundForGame(): Promise<GameRoundMapping | null> {
    this.unavailable();
  }

  async getMapping(): Promise<GameRoundMapping | null> {
    this.unavailable();
  }
}

class EnabledMarketService implements MarketService {
  readonly enabled = true;
  private readonly client: CastMarketClient;

  constructor() {
    this.client = new CastMarketClient(
      env.MARKET_RPC_URL!,
      env.MARKET_CONTRACT_ADDRESS!,
      env.MARKET_OPERATOR_PRIVATE_KEY!
    );
  }

  async getMapping(gameId: string): Promise<GameRoundMapping | null> {
    return getGameRoundMapping(gameId);
  }

  private toFailureReason(error: unknown): string {
    if (error instanceof Error) return error.message;
    return 'Unknown market sync error.';
  }

  private isRoundNotClosedError(error: unknown): boolean {
    const message = this.toFailureReason(error).toLowerCase();
    return (
      message.includes('roundnotclosed') ||
      message.includes('round not closed') ||
      message.includes('0x29e3b953')
    );
  }

  private isRoundAlreadyResolvedError(error: unknown): boolean {
    const message = this.toFailureReason(error).toLowerCase();
    return message.includes('roundalreadyresolved') || message.includes('round already resolved');
  }

  async openRoundForGame(input: { gameId: string; lockSeconds?: number }): Promise<GameRoundMapping> {
    const existing = await getGameRoundMapping(input.gameId);
    if (existing) return existing;

    await getGame(input.gameId);

    const gameIdHash = await this.client.keccak(input.gameId);
    const lockSeconds = input.lockSeconds ?? env.MARKET_ROUND_LOCK_SECONDS;
    const lockAt = Math.floor(Date.now() / 1000) + lockSeconds;

    try {
      const txHash = await this.client.openRound(gameIdHash, lockAt);
      const roundId = await this.client.getRoundIdByGameHash(gameIdHash);
      const chainId = await this.client.chainId();

      const opened = await createOrUpdateRoundOpened({
        gameId: input.gameId,
        gameIdHash,
        roundId,
        marketAddress: env.MARKET_CONTRACT_ADDRESS!,
        chainId,
        openTxHash: txHash
      });

      if (chainId !== env.MARKET_CHAIN_ID_EXPECTED) {
        const reason = `Market chain mismatch. expected=${env.MARKET_CHAIN_ID_EXPECTED}, actual=${chainId}`;
        await markRoundFailed({
          gameId: input.gameId,
          failureReason: reason
        });
        throw new HttpError(409, reason);
      }

      return opened;
    } catch (error) {
      await markRoundFailed({
        gameId: input.gameId,
        failureReason: this.toFailureReason(error)
      });
      throw error;
    }
  }

  async resolveRoundForGame(input: {
    gameId: string;
    winnerPlayerId?: string;
    skipIfNotOpened?: boolean;
  }): Promise<GameRoundMapping | null> {
    const mapping = await getGameRoundMapping(input.gameId);
    if (!mapping) {
      if (input.skipIfNotOpened) return null;
      throw new HttpError(404, `Round mapping not found for game: ${input.gameId}`);
    }

    if (mapping.resolvedAt) {
      return mapping;
    }

    const game = await getGame(input.gameId);
    const winnerPlayerId = input.winnerPlayerId ?? game.state.winner?.id;
    if (!winnerPlayerId) {
      throw new HttpError(409, `Game ${input.gameId} has no winner yet.`);
    }
    const winnerOutcomeHash = await this.client.keccak(winnerPlayerId);

    try {
      const txHash = await this.client.resolveRound(mapping.roundId, winnerOutcomeHash);

      return markRoundResolved({
        gameId: input.gameId,
        resolveTxHash: txHash,
        winnerOutcomeHash
      });
    } catch (error) {
      if (this.isRoundNotClosedError(error)) {
        throw new HttpError(409, `Round not closed yet for game: ${input.gameId}`);
      }

      if (this.isRoundAlreadyResolvedError(error)) {
        return markRoundResolved({
          gameId: input.gameId,
          resolveTxHash: null,
          winnerOutcomeHash
        });
      }

      await markRoundFailed({
        gameId: input.gameId,
        failureReason: this.toFailureReason(error)
      });
      throw error;
    }
  }
}

export function createMarketService(): MarketService {
  if (!env.MARKET_ENABLED) {
    return new DisabledMarketService();
  }
  return new EnabledMarketService();
}
