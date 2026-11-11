import { createDns } from '../dns';

export function createDnsBuiltins(isIP: (value: string) => number) {
  const dns = createDns(isIP);
  return {
    dns,
    'dns/promises': dns.promises,
  };
}
