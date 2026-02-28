/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GAME_MODE?: 'local' | 'online';
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CHAIN_MARKET_ENABLED?: string;
  readonly VITE_MARKET_CHAIN_ID?: string;
  readonly VITE_MARKET_CONTRACT_ADDRESS?: string;
  readonly VITE_MARKET_BET_WEI_DEFAULT?: string;
  readonly VITE_MARKET_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
