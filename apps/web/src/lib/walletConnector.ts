import type { Connector } from 'wagmi';

const includesIgnoreCase = (value: string | undefined, pattern: string): boolean =>
  (value ?? '').toLowerCase().includes(pattern);

export function pickPreferredConnector(connectors: readonly Connector[]): Connector | undefined {
  if (connectors.length === 0) return undefined;

  const byMetaMask = connectors.find((connector) => {
    return (
      includesIgnoreCase(connector.id, 'metamask') ||
      includesIgnoreCase(connector.name, 'metamask')
    );
  });
  if (byMetaMask) return byMetaMask;

  const byInjected = connectors.find((connector) => includesIgnoreCase(connector.id, 'injected'));
  if (byInjected) return byInjected;

  return connectors[0];
}
