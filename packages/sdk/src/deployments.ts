/** Canonical deployments (mirrors chain/deployments/*.json). */
export const deployments = {
  monadTestnet: {
    chainId: 10143,
    rpcUrl: "https://testnet-rpc.monad.xyz",
    registry: "0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31",
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    deployBlock: 67062103n,
  },
} as const;
