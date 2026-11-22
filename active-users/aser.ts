import { Dependencies, FetchOptions, SimpleAdapter } from '../adapters/types';
import { getAlliumChain, queryAllium } from '../helpers/allium';
import { CHAIN } from '../helpers/chains';

// ASER (https://aser.trade) is non-custodial: each user trades from their own wallet, and every swap pays
// a fixed 1% fee to this wallet inside the same transaction. A wallet that paid that fee in a transaction that
// also contains a DEX swap traded that day; plain transfers to the fee wallet are not counted.
const FEE_WALLET = '5VmZHp6GwbLBHsp4f1CRogWV7RcfSk2KdSuxdyMe8LqD';

// EVM: the fee address also receives unrelated native transfers, so a user is the sender of a transaction in
// which the chain's Universal Router (or four.meme's TokenManager2 on BSC) paid the fee to that address, as in
// fees/aser.ts. Transactions sent by the fee address itself are excluded.
const EVM_FEE_ADDRESS = '0xdcf212729f8abde35e31ac1b2d971061509d722b';
const EVM_CONFIG: Record<string, { start: string, feePayers: string[] }> = {
  [CHAIN.BSC]: { start: '2026-11-08', feePayers: ['0xd9c500dff816a1da21a48a732d3498bf09dc9aeb', '0x5c952063c7fc8610ffdb798152d69f0b9550762b'] },
  [CHAIN.BASE]: { start: '2026-11-08', feePayers: ['0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40'] },
  [CHAIN.ETHEREUM]: { start: '2026-11-08', feePayers: ['0x23617e59a5925b2a4bf75d73ff6711cd0b29de85'] },
  [CHAIN.ARBITRUM]: { start: '2026-11-10', feePayers: ['0x2d01411773c8c24805306e89a41f7855c3c4fe65'] },
  [CHAIN.AVAX]: { start: '2026-11-10', feePayers: ['0x661e93cca42afacb172121ef892830ca3b70f08d'] },
};

const fetchSolana = async (options: FetchOptions) => {
  const timeRange = `block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp}) AND block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})`;

  const result = await queryAllium(`
    SELECT
      COUNT(DISTINCT t.from_address) AS active_users,
      COUNT(DISTINCT t.txn_id)       AS trades
    FROM solana.assets.transfers t
    WHERE t.to_address = '${FEE_WALLET}'
      AND t.from_address != '${FEE_WALLET}'
      AND t.${timeRange}
      AND t.txn_id IN (
        SELECT txn_id
        FROM solana.dex.trades
        WHERE ${timeRange}
      )
  `);

  const row = result[0];
  if (!row) throw new Error(`No ASER user data for ${options.dateString}`);

  return {
    dailyActiveUsers: row.active_users,
    dailyTransactionsCount: row.trades,
  };
};

const fetchEvm = async (options: FetchOptions) => {
  const { feePayers } = EVM_CONFIG[options.chain]
  const allium = getAlliumChain(options.chain);
  const timeRange = (alias: string) => `${alias}.block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp}) AND ${alias}.block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})`;

  const result = await queryAllium(`
    SELECT
      COUNT(DISTINCT tx.from_address) AS active_users,
      COUNT(DISTINCT tx.hash)         AS trades
    FROM ${allium}.assets.native_token_transfers t
    JOIN ${allium}.raw.transactions tx
      ON tx.hash = t.transaction_hash
      AND ${timeRange('tx')}
    WHERE t.to_address = '${EVM_FEE_ADDRESS}'
      AND t.from_address IN (${feePayers.map((a) => `'${a}'`).join(', ')})
      AND tx.from_address != '${EVM_FEE_ADDRESS}'
      AND t.transfer_type = 'value_transfer'
      AND ${timeRange('t')}
  `);

  const row = result[0];
  if (!row) throw new Error(`No ASER user data for ${options.chain} ${options.dateString}`);

  return {
    dailyActiveUsers: row.active_users,
    dailyTransactionsCount: row.trades,
  };
};

const evmAdapters = Object.fromEntries(
  Object.entries(EVM_CONFIG).map(([chain, { start }]) => [chain, { fetch: fetchEvm, start }])
);

const adapter: SimpleAdapter = {
  version: 1,
  dependencies: [Dependencies.ALLIUM],
  adapter: {
    [CHAIN.SOLANA]: {
      fetch: fetchSolana,
      start: '2026-11-01',
    },
    ...evmAdapters,
  },
  methodology: {
    ActiveUsers: 'Unique wallets that traded through ASER that day. Solana: wallets that paid the 1% trading fee to the ASER fee wallet in a transaction that contains a DEX swap. EVM: senders of swap transactions in which the Universal Router (or four.meme on BSC) paid the fee to ASER\'s fee address; two-transaction curve trades are not counted.',
    TransactionsCount: 'Number of swaps made through ASER that day, identified the same way.',
  },
  isExpensiveAdapter: true,
};

export default adapter;
