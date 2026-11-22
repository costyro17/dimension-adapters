import { Dependencies, FetchOptions, SimpleAdapter } from "../adapters/types";
import { CHAIN } from "../helpers/chains";
import { getAlliumChain, queryAllium } from "../helpers/allium";
import { METRIC } from "../helpers/metrics";

// ASER (https://aser.trade) is a non-custodial memecoin trading terminal. Every swap made through it
// pays a fixed 1% fee, inside the same transaction, to this wallet.
const FEE_WALLET = '5VmZHp6GwbLBHsp4f1CRogWV7RcfSk2KdSuxdyMe8LqD'
const LABEL_TO_ASER = 'Trading Fees to ASER'

// On EVM the 1% is paid in the chain's native coin to one address, the same on every chain. That address is
// also an ordinary wallet that receives other native transfers (its own sales, bridge deliveries, plain
// transfers), so "everything it receives" is NOT the fee. Only the atomic fee paths are counted:
// - Universal Router trades: the router itself sends the fee (TRANSFER on a buy, PAY_PORTION on a sell) to
//   the fee address inside the user's swap transaction, so it shows up as an internal native transfer whose
//   sender is the chain's Universal Router;
// - four.meme sells (BSC): sellToken(..., feeRate = 100, feeRecipient = fee address), paid by TokenManager2.
// Transactions sent by the fee address itself are excluded: there the router also pays it the sale proceeds,
// and its own trades are not users paying ASER. Two-transaction paths (four.meme/Flap curve buys, Flap sells,
// SushiSwap on Arbitrum, Pons on Robinhood) pay the fee as a plain transfer that cannot be told apart from any
// other transfer, so they are left out: EVM fees are a lower bound.
const EVM_FEE_ADDRESS = '0xdcf212729f8abde35e31ac1b2d971061509d722b'
const EVM_CONFIG: Record<string, { start: string, feePayers: string[] }> = {
  [CHAIN.BSC]: {
    start: '2026-11-08',
    feePayers: [
      '0xd9c500dff816a1da21a48a732d3498bf09dc9aeb', // PancakeSwap Infinity Universal Router
      '0x5c952063c7fc8610ffdb798152d69f0b9550762b', // four.meme TokenManager2 (sellToken feeRecipient)
    ],
  },
  [CHAIN.BASE]: {
    start: '2026-11-08',
    feePayers: ['0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40'], // Uniswap Universal Router 2.1.2
  },
  [CHAIN.ETHEREUM]: {
    start: '2026-11-08',
    feePayers: ['0x23617e59a5925b2a4bf75d73ff6711cd0b29de85'], // Uniswap Universal Router 2.1.2
  },
  [CHAIN.ARBITRUM]: {
    start: '2026-11-10',
    feePayers: ['0x2d01411773c8c24805306e89a41f7855c3c4fe65'], // Uniswap Universal Router 2.1.2
  },
  [CHAIN.AVAX]: {
    start: '2026-11-10',
    feePayers: ['0x661e93cca42afacb172121ef892830ca3b70f08d'], // Uniswap Universal Router 2.1.2
  },
}

const fetchSolana = async (options: FetchOptions) => {
  const dailyFees = options.createBalances()
  const dailyRevenue = options.createBalances()
  const res = await queryAllium(`
    SELECT t.mint as token, SUM(t.raw_amount) as amount
    FROM solana.assets.transfers t
    WHERE t.to_address IN ('${FEE_WALLET}')
      AND t.block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp})
      AND t.block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})
      AND NOT EXISTS (
        SELECT 1
        FROM solana.assets.transfers o
        WHERE o.txn_id = t.txn_id
          AND o.from_address IN ('${FEE_WALLET}')
          AND o.block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp})
          AND o.block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})
      )
    GROUP BY t.mint
  `)

  res.forEach((row: any) => {
    dailyFees.add(row.token, row.amount, METRIC.TRADING_FEES)
    dailyRevenue.add(row.token, row.amount, LABEL_TO_ASER)
  })

  return { dailyFees, dailyUserFees: dailyFees, dailyRevenue, dailyProtocolRevenue: dailyRevenue }
}

const fetchEvm = async (options: FetchOptions) => {
  const dailyFees = options.createBalances()
  const dailyRevenue = options.createBalances()
  const { feePayers } = EVM_CONFIG[options.chain]
  const allium = getAlliumChain(options.chain)
  const timeRange = (alias: string) => `${alias}.block_timestamp >= TO_TIMESTAMP_NTZ(${options.startTimestamp})
        AND ${alias}.block_timestamp < TO_TIMESTAMP_NTZ(${options.endTimestamp})`
  const res = await queryAllium(`
    SELECT COALESCE(SUM(t.raw_amount), 0) AS amount
    FROM ${allium}.assets.native_token_transfers t
    JOIN ${allium}.raw.transactions tx
      ON tx.hash = t.transaction_hash
      AND ${timeRange('tx')}
    WHERE t.to_address = '${EVM_FEE_ADDRESS}'
      AND t.from_address IN (${feePayers.map((a) => `'${a}'`).join(', ')})
      AND tx.from_address != '${EVM_FEE_ADDRESS}'
      AND t.transfer_type = 'value_transfer'
      AND ${timeRange('t')}
  `)

  const amount = res[0]?.amount ?? 0
  dailyFees.addGasToken(amount, METRIC.TRADING_FEES)
  dailyRevenue.addGasToken(amount, LABEL_TO_ASER)

  return { dailyFees, dailyUserFees: dailyFees, dailyRevenue, dailyProtocolRevenue: dailyRevenue }
}

const breakdownMethodology = {
  Fees: {
    [METRIC.TRADING_FEES]: "Fixed 1% fee on every swap made through ASER, paid by the user inside the swap transaction.",
  },
  UserFees: {
    [METRIC.TRADING_FEES]: "Fixed 1% fee on every swap made through ASER, paid by the user inside the swap transaction.",
  },
  Revenue: {
    [LABEL_TO_ASER]: "The trading fee received by ASER's fee wallet.",
  },
  ProtocolRevenue: {
    [LABEL_TO_ASER]: "The trading fee received by ASER's fee wallet.",
  },
}

const evmAdapters = Object.fromEntries(
  Object.entries(EVM_CONFIG).map(([chain, { start }]) => [chain, { fetch: fetchEvm, start }])
)

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  adapter: {
    [CHAIN.SOLANA]: {
      fetch: fetchSolana,
      start: '2026-11-01',
    },
    ...evmAdapters,
  },
  dependencies: [Dependencies.ALLIUM],
  isExpensiveAdapter: true,
  methodology: {
    Fees: "Trading fees paid by users: a fixed 1% of every swap made through ASER (0.9% for referred users on EVM, where the referrer receives half). Solana: transfers received by the fee wallet, except in transactions it sends itself. EVM: only the native-coin fee paid to ASER's fee address by the Universal Router (or four.meme's TokenManager2 on BSC) inside a user's swap transaction; transactions sent by the fee address itself and two-transaction curve trades are not counted.",
    UserFees: "Trading fees paid by users: a fixed 1% of every swap made through ASER.",
    Revenue: "Trading fees received by ASER's fee address.",
    ProtocolRevenue: "Trading fees received by ASER's fee address.",
  },
  breakdownMethodology,
};

export default adapter;
