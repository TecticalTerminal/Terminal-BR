
import React from 'react';
import { GameProvider } from './context/GameContext';
import { Dashboard } from './components/Dashboard';

const parseWatchGameIdFromPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/watch\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const App: React.FC = () => {
  const initialSpectatorGameId =
    typeof window !== 'undefined' ? parseWatchGameIdFromPath(window.location.pathname) : null;

  return (
    <GameProvider>
      <Dashboard initialSpectatorGameId={initialSpectatorGameId} />
    </GameProvider>
  );
};

export default App;
